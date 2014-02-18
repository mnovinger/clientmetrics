(function() {
    var _ = require('underscore');
    var BatchSender = require('./batchSender');

    // The default for max number of errors we will send per session.
    // In ALM, a session is started for each page visit.
    var DEFAULT_ERROR_LIMIT = 25;

    // bookkeeping properties that are set on components being measured
    var _currentEventId = '__clientMetricsCurrentEventId__';
    var _metricsIdProperty = '__clientMetricsID__';

    /**
     * @module Aggregator
     */

    /**
     * @class Aggregator
     * An aggregator that listens to all client metric related messages that go out on
     * the message bus and creates a cohesive picture of what is happening, then pushes
     * this data out to an endpoint which collects the data for analysis
     *
     * ##Aggregator specific terminology##
     *
     * * **event:** A distinct, measurable thing that the page did or the user invoked. For example, clicking on a button,
     * a panel loading, or a grid resorting are all events
     * * **handler:** A helper object that helps the aggregator identify where events came from.
     * * **status:** What was the ultimate fate of an event? If a panel fully loads and becomes fully usable, the event associated
     * with the panel load will have the status of "Ready". If the user navigates away from the page before the panel
     * finishes loading, the associated event's conclusion will be "Navigation". Current conclusion values are:
     *     - Ready: the event concluded normally
     *     - Navigation: the user navigated away before the event could complete
     *     - Timeout: (Not yet implemented), indicates a load event took too long
     *
     *
     *  NOTE: space is an issue when sending the bundle of data out. So most properties are short acronyms:
     *  * bts -- browser time stamp
     *  * tabId -- the browser tab ID
     *  * tId -- trace ID
     *  * eId -- event ID
     *  * pId -- parent ID
     *  * eType -- event type (ie load, action or dataRequest)
     *  * eDesc -- event description
     *  * cmpType -- component type
     *  * cmpId -- component ID
     *
     */
    /**
     * @constructor
     * @param {Object} config Configuration object
     * @param {Object[]} [config.ajaxProviders] Ajax providers that emit the following events:
     *   * beforerequest - When an Ajax request is about to be made
     *   * requestcomplete - When an Ajax request has finished
     * @param {Object} [config.sender = BatchSender] Which sender to use. By default,
     *   a BatchSender will be used.
     * @param {Number} [config.flushInterval] If defined, events will be sent at least that often.
     * @param {String} [config.beaconUrl = "https://trust.f4tech.com/beacon/"] URL where the beacon is located.
     */
    var Aggregator = function(config) {
        _.extend(this, config);

        this._pendingEvents = [];
        this._browserTabId = this._getUniqueId();
        this._startingTime = new Date().getTime();
        this._loadedComponents = [];

        // keep track of how many errors we have reported on, so we
        // can stop after a while and not flood the beacon
        this._errorCount = 0;
        this.errorLimit = this.errorLimit || DEFAULT_ERROR_LIMIT;

        this.handlers = this.handlers || [];

        this.sender = this.sender || new BatchSender({
            keysToIgnore: [ 'cmp' ],
            beaconUrl: config.beaconUrl
        });

        if (_.isFunction(this.sender.getMaxLength)) {
            this.maxErrorLength = Math.floor(this.sender.getMaxLength() * 0.9);
        }

        if (_.isNumber(this.flushInterval)) {
            this._flushIntervalId = window.setInterval(_.bind(this.sendAllRemainingEvents, this), this.flushInterval);
        }
    };

    _.extend(Aggregator.prototype, {

        destroy: function() {
            if (this._flushIntervalId) {
                window.clearInterval(this._flushIntervalId);
            }
        },

        /**
         * Handles the starting of a new "session"
         * Finishes and sends off pending events with a Navigation status
         * Resets current parent events queue, starting time, and current hash
         * Calls a new navigation user action
         * @param status the event's status for each of the pending events
         * @param defaultParams Default parameters that are sent with each request
         */
        startSession: function(status, defaultParams) {
            this._concludePendingEvents(status);
            this.sendAllRemainingEvents();
            this._defaultParams = defaultParams;

            this._errorCount = 0;
            this._loadedComponents = [];
        },

        /**
         * Handles the action client metrics message. Starts and completes a client metric event
         */
        recordAction: function(options) {
            var cmp = options.component;
            delete options.component;
            var eventId = this._getUniqueId();
            var startTime = this._getRelativeTime(options.startTime || new Date().getTime());

            var action = this._startEvent(_.defaults({
                eType: 'action',
                cmp: cmp,
                cmpH: this._getHierarchyString(cmp),
                eDesc: options.description,
                cmpId: this._getComponentId(cmp),
                eId: eventId,
                tId: eventId,
                status: 'Ready',
                cmpType: this.getComponentType(cmp),
                start: startTime
            }, options.miscData));

            this._currentUserActionEventId = action.eId;

            this._finishEvent(action, {
                stop: startTime
            });
        },

        recordError: function(errorInfo) {
            if (this._currentUserActionEventId && this._errorCount < this.errorLimit) {
                ++this._errorCount;

                var errorMsg = errorInfo || 'unknown error';
                if (this.maxErrorLength) {
                    errorMsg = errorMsg.substring(0, this.maxErrorLength);
                }

                var startTime = this._getRelativeTime();

                var errorEvent = this._startEvent({
                    eType: 'error',
                    error: errorMsg,
                    eId: this._getUniqueId(),
                    tId: this._currentUserActionEventId,
                    start: startTime
                });

                this._finishEvent(errorEvent, {
                    stop: startTime
                });

                // dont want errors to get left behind in the batch, force it to be sent now
                this.sendAllRemainingEvents();
            }
        },

        /**
         * Handles the beginLoad client metrics message. Starts an event
         */
        beginLoad: function(options) {
            var cmp = options.component;
            delete options.component;
            if (!this._currentUserActionEventId) {
                return;
            }

            if (cmp[_currentEventId + 'load']) {
                // already an in flight load event, so going to bail on this one
                return;
            }

            var startTime = this._getRelativeTime(options.startTime || new Date().getTime());

            var eventId = this._getUniqueId();
            cmp[_currentEventId + 'load'] = eventId;

            var event = _.defaults({
                eType: 'load',
                cmp: cmp,
                cmpH: this._getHierarchyString(cmp),
                eDesc: options.description,
                cmpId: this._getComponentId(cmp),
                eId: eventId,
                cmpType: this.getComponentType(cmp),
                tId: this._currentUserActionEventId,
                pId: this._findParentId(cmp, this._currentUserActionEventId),
                start: startTime
            }, options.miscData);
            this._startEvent(event);
        },

        /**
         * Handles the endLoad client metrics message. Finishes an event
         */
        endLoad: function(options) {
            var cmp = options.component;
            delete options.component;
            if (!this._currentUserActionEventId) {
                return;
            }

            var eventId = cmp[_currentEventId + 'load'];

            if (!eventId) {
                // load end found without a load begin, not much can be done with it
                return;
            }

            delete cmp[_currentEventId + 'load'];

            var event = this._findPendingEvent(eventId);

            if (!event) {
                // if we didn't find a pending event, then the load begin happened before the
                // aggregator was ready or a new session was started. Since this load is beyond the scope of the aggregator,
                // just ignoring it.
                return;
            }

            options.stop = this._getRelativeTime(options.stopTime || new Date().getTime());

            var isFirstLoad = this._loadedComponents.indexOf(cmp) === -1;

            if (isFirstLoad) {
                this._loadedComponents.push(cmp);
            }

            this._finishEvent(event, _.extend({
                status: 'Ready',
                first: isFirstLoad
            }, options));
        },

        /**
         * Handler for before Ajax requests go out. Starts an event for the request,
         * Adds headers to the ajax request that links the request with the client metrics data
         */
        beginDataRequest: function(requester, url) {
            var metricsData;
            if (requester && this._currentUserActionEventId) {
                var eventId = this._getUniqueId();
                var traceId = this._currentUserActionEventId;
                var parentId = this._findParentId(requester, this._currentUserActionEventId);
                var ajaxRequestId = this._getUniqueId();
                requester[_currentEventId + 'dataRequest' + ajaxRequestId] = eventId;

                this._startEvent({
                    eType: 'dataRequest',
                    cmp: requester,
                    cmpH: this._getHierarchyString(requester),
                    url: this._getUrl(url),
                    cmpType: this.getComponentType(requester),
                    cmpId: this._getComponentId(requester),
                    eId: eventId,
                    tId: traceId,
                    pId: parentId
                });

                // NOTE: this looks wrong, but it's not
                // This client side dataRequest event is going to be
                // the "parent" of the server side event that responds.
                // So in the request headers, sending the current event Id as
                // the parent Id.
                metricsData = {
                    requestId: ajaxRequestId,
                    xhrHeaders: {
                        'X-Trace-Id': traceId,
                        'X-Parent-Id': eventId
                    }
                };
            }

            return metricsData;
        },

        /**
         * handler for after the Ajax request has finished. Finishes an event for the data request
         */
        endDataRequest: function(requester, xhr, requestId) {
            if (requester && this._currentUserActionEventId) {
                
                var eventId = requester[_currentEventId + 'dataRequest' + requestId];

                var event = this._findPendingEvent(eventId);
                if (!event) {
                    // if we didn't find a pending event, then the request started before the
                    // aggregator was ready or a new session was started. Since this load is beyond the scope of the aggregator,
                    // just ignoring it.
                    return;
                }
                
                var newEventData = {
                    status: 'Ready'
                };
                var rallyRequestId = this._getRallyRequestId(xhr);

                if (rallyRequestId) {
                    newEventData.rallyRequestId = rallyRequestId;
                }

                this._finishEvent(event, newEventData);
            }
        },

        /**
         * Causes the sender to purge all events it may still have in its queue.
         * Typically done when the user navigates somewhere
         */
        sendAllRemainingEvents: function() {
            this.sender.flush();
        },

        getComponentType: function(cmp) {
            return this._getFromHandlers(cmp, 'getComponentType');
        },

        /**
         * Creates a version 4 UUID
         * @private
         */
        /* jshint -W016 */
        /* jshint -W116 */
        _getUniqueId: function() {
            return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
                var r = Math.random()*16|0, v = c == 'x' ? r : (r&0x3|0x8);
                return v.toString(16);
            });
        },
        /* jshint +W016 */
        /* jshint +W116 */

        /**
         * Gets the current timestamp relative to the starting time
         * @param {Number} timestamp Timestamp to be converted
         * @private
         */
        _getRelativeTime: function(timestamp) {
            return (timestamp || new Date().getTime()) - this._startingTime;
        },

        /**
         * Finishes an event object by completing necessary event properties
         * Adds this event object to the finished event queue
         * Sends finished events before clearing the finished events queue
         * @param existingEvent the event object that has started
         * @param newEventData an object with event properties to append if
         * it doesn't already exist on the event
         * @private
         */
        _finishEvent: function(existingEvent, newEventData) {
            var stop = this._getRelativeTime();

            var event = _.defaults(
                {},
                existingEvent,
                newEventData,
                {
                    stop: stop
                },
                this._defaultParams,
                this._guiTestParams
            );

            this._pendingEvents = _.without(this._pendingEvents, existingEvent);

            this.sender.send(event);
        },

        /**
         * Starts an event object by completing necessary event properties
         * Adds this new event object to the pending and current parent event queue
         * @param event the event object with event properties
         * @private
         */
        _startEvent: function(event) {
            event.bts = new Date().getTime();
            event.tabId = this._browserTabId;

            if (!_.isNumber(event.start)) {
                event.start = this._getRelativeTime();
            }

            if (event.cmp) {
                var appName = this._getFromHandlers(event.cmp, 'getAppName');

                if (appName) {
                    event.appName = appName;
                }
            }

            this._pendingEvents.push(event);

            return event;
        },

        /**
         * Determines which handler (Ext4/Legacy Dashboard) to use for the requested method
         * @param cmp the component parameter used for the handler's method
         * @param methodName the method being requested
         * @private
         */
        _getFromHandlers: function(cmp, methodName) {
            var result = null;

            _.each(this.handlers, function(handler) {
                result = handler[methodName](cmp);
                return !result;
            });

            return result;
        },

        /**
         * Finds the parent's event ID
         * @param sourceCmp the component to get the parent's event ID for
         * @private
         */
        _findParentId: function(sourceCmp, traceId) {
            var hierarchy = this._getFromHandlers(sourceCmp, 'getComponentHierarchy') || [];
            var eventId = traceId;

            _.each(hierarchy, function(cmp) {
                parentEvent = _.findLast(this._pendingEvents, function(event) {
                    return event.eType !== 'dataRequest' && (event.cmp === cmp || event.cmp === sourceCmp) && event.tId === traceId;
                });
                if (parentEvent) {
                    eventId = parentEvent.eId;
                    return false;
                }
            }, this);

            return eventId;
        },

        /**
         * Sets the metrics Id property for the component with a generated uuid
         * @param cmp the component to get an ID for
         * @private
         */
        _getComponentId: function(cmp) {
            if (!cmp[_metricsIdProperty]) {
                cmp[_metricsIdProperty] = this._getUniqueId();
            }

            return cmp[_metricsIdProperty];
        },

        _getHierarchyString: function(cmp) {
            var hierarchy = this._getFromHandlers(cmp, 'getComponentHierarchy');

            if (!hierarchy) {
                return 'none';
            }

            var names = _.map(hierarchy, this.getComponentType, this);

            return _.compact(names).join(':');
        },

        /**
         * Massages the AJAX url into a smaller form. Strips away the host and query
         * parameters.
         *
         * Example: http://server/slm/webservice/1.27/Defect.js?foo=bar&baz=buzz
         * becomes 1.27/Defect.js
         * @param url The url to clean up
         */
        _getUrl: function(url) {
            if (!url) {
                return "unknown";
            }

            var webserviceSlug = 'webservice/';
            var webserviceIndex = url.indexOf(webserviceSlug);
            var questionIndex;

            if (webserviceIndex > -1) {
                questionIndex = url.indexOf('?', webserviceIndex);

                if (questionIndex < 0) {
                    questionIndex = url.length;
                }

                var skip = webserviceSlug.length;
                return url.substring(webserviceIndex + skip, questionIndex);
            } else {
                questionIndex = url.indexOf('?');

                if (questionIndex < 0) {
                    return url;
                }

                return url.substring(0, questionIndex);
            }
        },

        /**
         * Finds the RallyRequestId, if any, in the response sent back from the server
         * @param response the response that came back from an Ajax request
         * @private
         */
        _getRallyRequestId: function(response) {
            if(response) {
                if(_.isObject(response.responseHeaders)) {
                    return response.responseHeaders.RallyRequestID;

                } else if(_.isFunction(response.getResponseHeader)) {
                    return response.getResponseHeader('RallyRequestID');
                    
                } else if(_.isObject(response.getResponseHeader)) {
                    return response.getResponseHeader.RallyRequestID;
                }
            }
        },

        /**
         * Finds an event withing the pending events queue if one exists
         * @param eventId the event's ID used to find a match within the pending events
         * @private
         */
        _findPendingEvent: function(eventId) {
            return _.find(this._pendingEvents, {eId: eventId});
        },

        /**
         * Loops through each pending event and finishes the event
         * @param status the event's status for each of the pending events
         * @private
         */
        _concludePendingEvents: function(status) {
            var pendingEvents = this._pendingEvents,
                now = this._getRelativeTime(),
                newEventData = {status: status, stop: now};
            _.each(pendingEvents, function(event) {
                this._finishEvent(event, newEventData);
            }, this);
        }
    });

    module.exports = Aggregator;
})();
