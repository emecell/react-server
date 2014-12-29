// the common object model of triton on server and client -sra.

module.exports = {
	PageObject: require("./core/PageObject"),
	BaseStore: require('./core/stores/BaseStore'),
	Link: require('./core/components/Link'),
	actions: require('./core/actions'),
	ObjectGraph: require('./core/util/ObjectGraph'),
	bundleNameUtil: require("./core/util/bundleNameUtil"),
	config: require("./core/config")
}