
var EventEmitter = require('events').EventEmitter,
	logger = require('../logging').getLogger(__LOGGER__),
	Router = require('routr'),
	Q = require('q'),
	History = require("../components/History"),
	ReactServerAgent = require("../ReactServerAgent"),
	PageUtil = require("../util/PageUtil"),
	DebugUtil = require("../util/DebugUtil"),
	{setResponseLoggerPage} = SERVER_SIDE ? require('../logging/response') : { setResponseLoggerPage: () => {} };

class Navigator extends EventEmitter {

	constructor (context, routes) {
		super();

		this.router = new Router(routes.routes);
		this.context = context;

		this._globalMiddleware = routes.middleware;
		this._loading = false;
		this._currentRoute = null;
		this._nextRoute = null;
	}

	/**
	 * type is one of
	 *    History.events.PUSHSTATE: user clicked something to go forward but browser didn't do a
	 * full page load
	 *    History.events.POPSTATE: user clicked back button but browser didn't do a full page load
	 *    History.events.PAGELOAD: full browser page load, not using History API.
	 *
	 * Default is History.events.PAGELOAD.
	 */
	navigate (request, type) {

		logger.debug(`Navigating to ${request.getUrl()}`);
		type = type || History.events.PAGELOAD;

		this._haveInitialized = true;

		// Pull debug parameters out of the query string and expose via a well
		// defined interface.
		DebugUtil.setRequest(request);

		var route = this.router.getRoute(request.getUrl(), { method: request.getMethod() });

		if (route) {
			logger.debug(`Mapped ${request.getUrl()} to route ${route.name}`);
		} else {
			this.emit('navigateDone', { status: 404, message: "No Route!" }, null, request.getUrl(), type);
			return;
		}

		// We may or may not _actually_ start this route client side.
		//
		// If there's a flurry of navigation we skip any routes that
		// blow by while we're still working on a page, and only
		// finally start the _last_ one.
		//
		// The promise returned from `startRoute()` will be rejected
		// if we're not going to proceed, so resources will be freed.
		//
		this
		.startRoute(route, request, type)

		// We might have a data bundle on hand, or the request may
		// have asked us to fetch it one.
		.then(this._dealWithDataBundleLoading.bind(this, request))

		.then(() => {
			if (this._ignoreCurrentNavigation){
				// This is a one-time deal.
				this._ignoreCurrentNavigation = false;
				return;
			}

			/* Breathe... */

			var loaders = route.config.page;

			var deviceType = this.context.getDeviceType();

			if (loaders[deviceType]) {
				route.name += "-" + deviceType;
			}

			// Our route may have multiple page implementations if
			// there are device-specific variations.
			//
			// We'll take one of those if the request device
			// matches, otherwise we'll use the default.
			//
			// Note that the page object may either directly be a
			// loader or it may be an object whose values are
			// loaders.
			(
				loaders[deviceType] ||
				loaders.default ||
				loaders
			)().done(pageConstructor => {
				if (request.setRoute) {
					request.setRoute(route);
				}
				this.handlePage(pageConstructor, request, type);

			}, err => {
				console.error("Error resolving page", err);
			});

		});

	}

	// If you call this you're responsible for calling `finishRoute()`
	// when you're done with whatever it is you're hiding from the
	// navigator.
	ignoreCurrentNavigation() {
		this._ignoreCurrentNavigation = true;
	}

	_dealWithDataBundleLoading(request) {

		// If we're managing a frame's navigation, we want _it_ to
		// use a data bundle.
		if (this._ignoreCurrentNavigation) return Q();

		// If this request doesn't use a data bundle, we're done.
		if (!request.getBundleData()) return Q();

		// If the request wants all of the data fetched as a bundle
		// we'll need to kick off the request for the bundle.
		return ReactServerAgent._fetchDataBundle(request.getUrl())
			.then(ReactServerAgent._rehydrateDataBundle)
			.catch(err => logger.error('Data bundle error', err));
	}

	handlePage(pageConstructor, request, type) {
		var page = PageUtil.createPageChain(pageConstructor, this._globalMiddleware);

		this.emit("page", page);

		page.setRequest(request);

		PageUtil.PageConfig.initFromPageWithDefaults(page, {
			isFragment    : false,
			isRawResponse : false,
		});

		// Set the page context on the response logger so it can figure
		// out whether to flush logs to the response document
		setResponseLoggerPage(page);

		// call page.handleRoute(), and use the resulting code to decide how to
		// respond.
		// We call it in a promise handler so any exception that
		// arises will get converted to a rejection that we can handle
		// below.
		Q().then(page.handleRoute).then(handleRouteResult => {

			page.setStatus(handleRouteResult.code);

			page.setHasDocument(handleRouteResult.hasDocument);

			page.setJsBelowTheFold(DebugUtil.getJsBelowTheFold() || handleRouteResult.jsBelowTheFold);
			page.setSplitJsLoad(DebugUtil.getSplitJsLoad() || handleRouteResult.splitJsLoad);

			// TODO: I think that 3xx/4xx/5xx shouldn't be considered "errors" in navigateDone, but that's
			// how the code is structured right now, and I'm changing too many things at once at the moment. -sra.
			if (handleRouteResult.code && ((handleRouteResult.code / 100)|0) !== 2) {
				this.emit("navigateDone", {status: handleRouteResult.code, redirectUrl: handleRouteResult.location}, page, request.getUrl(), type);
				return;
			}
			if (handleRouteResult.page) {
				// in this case, we should forward to a new page *without* changing the URL. Since we are already
				// in an async callback, we should schedule a new handlePage with the new page constructor and return
				// from this call.
				setTimeout(() => this.handlePage(handleRouteResult.page, request, type), 0);
				return;
			}

			this.emit('navigateDone', null, page, request.getUrl(), type);
		}).catch(err => {
			logger.error("Error while handling route", err);

			this.emit('navigateDone', {status: 500}, page, request.getUrl(), type);
		});

	}

	getState () {
		return {
			loading: this._loading,
			route: this._currentRoute,
		}
	}

	getCurrentRoute () {
		return this._currentRoute;
	}

	getLoading () {
		return this._loading;
	}

	startRoute (route, request, type) {

		// If we're being called with a requested route, we'll need to
		// tell the caller when they can proceed with their
		// navigation.
		var dfd, promise;

		// We need to handle the case where routes are requested while
		// we're handling the previous navigation.  This can happen if
		// the user furiously clicks the browser's forward/back
		// navigation buttons.
		//
		// We don't want a _queue_ here, because we're only ultimately
		// going to show the user the _final_ route that's requested,
		// so we'll just keep a single reference to the next route we
		// need to actually render once our current navigation is
		// complete.
		//
		if (request) {

			// We don't want to leave navigation detritus
			// laying around as we discard bypassed pages.
			if (this._nextRoute) this._nextRoute.dfd.reject();

			dfd = Q.defer(), promise = dfd.promise;

			this._nextRoute = {route, request, type, dfd};
		}

		// If we're _currently_ navigating, we'll wait to start the
		// next route until this navigation is complete.  Interleaved
		// navigation causes all kinds of havoc.
		if (!this._loading && this._nextRoute){

			const {route, request, type, dfd} = this._nextRoute;

			this._loading      = true;
			this._currentRoute = route;
			this._nextRoute    = null;

			this.emit('navigateStart', {route, request, type});

			// This allows the actual navigation to
			// proceed.
			dfd.resolve();
		}

		return promise;
	}

	finishRoute () {
		this._loading = false;

		this.emit('loadComplete');

		// If other routes were queued while we were navigating, we'll
		// start the next one right off.
		//
		this.startRoute();
	}
}

module.exports = Navigator;
