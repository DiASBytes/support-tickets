/*
 *       .                             .o8                     oooo
 *    .o8                             "888                     `888
 *  .o888oo oooo d8b oooo  oooo   .oooo888   .ooooo.   .oooo.o  888  oooo
 *    888   `888""8P `888  `888  d88' `888  d88' `88b d88(  "8  888 .8P'
 *    888    888      888   888  888   888  888ooo888 `"Y88b.   888888.
 *    888 .  888      888   888  888   888  888    .o o.  )88b  888 `88b.
 *    "888" d888b     `V88V"V8P' `Y8bod88P" `Y8bod8P' 8""888P' o888o o888o
 *  ========================================================================
 *  Author:     Chris Brame
 *  Updated:    1/20/19 4:43 PM
 *  Copyright (c) 2014-2019. All rights reserved.
 */

var _ = require('lodash')
var path = require('path')
var async = require('async')
var moment = require('moment')
var winston = require('winston')
var emitter = require('../emitter')
var util = require('../helpers/utils')
var ticketSchema = require('../models/ticket')
var userSchema = require('../models/user')
var NotificationSchema = require('../models/notification')
var settingsSchema = require('../models/setting')
var Email = require('email-templates')
var templateDir = path.resolve(__dirname, '..', 'mailer', 'templates')
var permissions = require('../permissions')

var notifications = require('../notifications') // Load Push Events

    ; (function () {
        notifications.init(emitter)

        emitter.on('ticket:created', function (data) {
            var ticketObj = data.ticket
            var hostname = data.hostname
            var requester = data.requester

            io.sockets.emit('ticket:updategrid')

            ticketSchema.getTicketById(ticketObj._id, function (err, ticket) {
                if (err) return false

                settingsSchema.getSettingsByName(
                    ['tps:enable', 'tps:username', 'tps:apikey', 'gen:siteurl', 'beta:email'],
                    function (err, tpsSettings) {
                        if (err) return false
                        var tpsEnabled = _.head(_.filter(tpsSettings, ['name', 'tps:enable']))
                        var tpsUsername = _.head(_.filter(tpsSettings, ['name', 'tps:username']))
                        var tpsApiKey = _.head(_.filter(tpsSettings, ['name', 'tps:apikey']))
                        var baseUrl = _.head(_.filter(tpsSettings, ['name', 'gen:siteurl'])).value

                        if (!tpsEnabled || !tpsUsername || !tpsApiKey) {
                            tpsEnabled = false
                        } else {
                            tpsEnabled = tpsEnabled.value
                            tpsUsername = tpsUsername.value
                            tpsApiKey = tpsApiKey.value
                        }

                        async.parallel(
                            [
                                function (c) {
                                    var emails = []
                                    async.each(
                                        ticket.group.sendMailTo,
                                        function (member, cb) {
                                            if (_.isUndefined(member.email)) return cb()
                                            if (member.deleted) return cb()

                                            emails.push(member.email)

                                            return cb()
                                        },
                                        function (err) {
                                            if (err) return c(err)

                                            var mailJet = require('../mailer/mailJet')

                                            emails = _.uniq(emails)

                                            var requesterIsAdmin = requester && requester.role && requester.role.isAdmin;

                                            // Only send email when status = 'Open'
                                            if (ticket.status === 0 && !requesterIsAdmin) {
                                                mailJet.sendTicketCreated(ticket).then(function (data) {
                                                    console.log('data', data);
                                                }).catch((err) => {
                                                    console.log('err', err);
                                                });
                                            }
                                        }
                                    )
                                },
                                function (c) {
                                    if (!ticket.group.public) return c()
                                    var rolesWithPublic = permissions.getRoles('ticket:public')
                                    rolesWithPublic = _.map(rolesWithPublic, 'id')
                                    userSchema.getUsersByRoles(rolesWithPublic, function (err, users) {
                                        if (err) return c()
                                        var ticketPushClone = _.clone(ticket)
                                        async.each(
                                            users,
                                            function (user, cb) {
                                                ticketPushClone.group.sendMailTo.push(user._id)
                                                return saveNotification(user, ticket, cb)
                                            },
                                            function (err) {
                                                sendPushNotification(
                                                    {
                                                        tpsEnabled: tpsEnabled,
                                                        tpsUsername: tpsUsername,
                                                        tpsApiKey: tpsApiKey,
                                                        hostname: hostname || baseUrl
                                                    },
                                                    { type: 1, ticket: ticketPushClone }
                                                )

                                                return c(err)
                                            }
                                        )
                                    })
                                },
                                function (c) {
                                    // Public Ticket Notification is handled above.
                                    if (ticket.group.public) return c()
                                    async.each(
                                        ticket.group.members,
                                        function (member, cb) {
                                            if (_.isUndefined(member)) return cb()

                                            return saveNotification(member, ticket, cb)
                                        },
                                        function (err) {
                                            sendPushNotification(
                                                {
                                                    tpsEnabled: tpsEnabled,
                                                    tpsUsername: tpsUsername,
                                                    tpsApiKey: tpsApiKey,
                                                    hostname: hostname || baseUrl
                                                },
                                                { type: 1, ticket: ticket }
                                            )

                                            return c(err)
                                        }
                                    )
                                }
                            ],
                            function (err) {
                                if (err) {
                                    return winston.warn('[trudesk:events:ticket:created] - Error: ' + err)
                                }

                                // Send Ticket..
                                util.sendToAllConnectedClients(io, 'ticket:created', ticket)
                            }
                        )
                    }
                )
            })
        })

        function sendPushNotification(tpsObj, data) {
            var tpsEnabled = tpsObj.tpsEnabled
            var tpsUsername = tpsObj.tpsUsername
            var tpsApiKey = tpsObj.tpsApiKey
            var hostname = tpsObj.hostname
            var ticket = data.ticket
            var message = data.message

            if (!tpsEnabled || !tpsUsername || !tpsApiKey) {
                winston.info('Warn: TPS - Push Service Not Enabled')
                return
            }

            if (!hostname) {
                winston.debug('Could not get hostname for push: ' + data.type)
                return
            }

            // Data
            // 1 - Ticket Created
            // 2 - Ticket Comment Added
            // 3 - Ticket Note Added
            // 4 - Ticket Assignee Set
            //  - Message
            var title
            var users = []
            var content
            switch (data.type) {
                case 1:
                    title = 'Ticket #' + ticket.uid + ' Created'
                    content = ticket.owner.fullname + ' submitted a ticket'
                    users = _.map(ticket.group.sendMailTo, function (o) {
                        return o._id
                    })
                    break
                case 2:
                    title = 'Ticket #' + ticket.uid + ' Updated'
                    content = _.last(ticket.history).description
                    var comment = _.last(ticket.comments)
                    users = _.compact(
                        _.map(ticket.subscribers, function (o) {
                            if (comment.owner._id.toString() !== o._id.toString()) {
                                return o._id
                            }
                        })
                    )
                    break
                case 3:
                    title = message.owner.fullname + ' sent you a message'
                    break
                case 4:
                    var assigneeId = data.assigneeId
                    var ticketUid = data.ticketUid
                    ticket = {}
                    ticket._id = data.ticketId
                    ticket.uid = data.ticketUid
                    title = 'Assigned to Ticket #' + ticketUid
                    content = 'You were assigned to Ticket #' + ticketUid
                    users = [assigneeId]
                    break
                default:
                    title = ''
            }

            if (_.size(users) < 1) {
                winston.debug('No users to push too | UserSize: ' + _.size(users))
                return
            }

            var n = {
                title: title,
                data: {
                    ticketId: ticket._id,
                    ticketUid: ticket.uid,
                    users: users,
                    hostname: hostname
                }
            }

            if (content) {
                n.content = content
            }

            notifications.pushNotification(tpsUsername, tpsApiKey, n)
        }

        function saveNotification(user, ticket, callback) {
            var notification = new NotificationSchema({
                owner: user,
                title: 'Ticket #' + ticket.uid + ' Created',
                message: ticket.subject,
                type: 0,
                data: { ticket: ticket },
                unread: true
            })

            notification.save(function (err) {
                if (_.isFunction(callback)) {
                    return callback(err)
                }
            })
        }

        emitter.on('ticket:updated', function (ticket) {
            io.sockets.emit('updateTicketStatus', {
                tid: ticket._id,
                owner: ticket.owner,
                status: ticket.status
            })

            io.sockets.emit('ticket:updategrid')
        })

        emitter.on('ticket:updated:mail', function (ticket, billingData, emails) {
            var mailJet = require('../mailer/mailJet')

            mailJet.sendClosedTicket(ticket, billingData, emails);
        })

        emitter.on('ticket:deleted', function (oId) {
            io.sockets.emit('ticket:delete', oId)
        })

        emitter.on('ticket:subscriber:update', function (data) {
            io.sockets.emit('ticket:subscriber:update', data)
        })

        emitter.on('ticket:comment:added', function (ticket, comment, hostname) {
            // Goes to client
            io.sockets.emit('updateComments', ticket)

            settingsSchema.getSettingsByName(['tps:enable', 'tps:username', 'tps:apikey'], function (err, tpsSettings) {
                if (err) return false

                var tpsEnabled = _.head(_.filter(tpsSettings, ['name', 'tps:enable']))
                var tpsUsername = _.head(_.filter(tpsSettings, ['name', 'tps:username']))
                var tpsApiKey = _.head(_.filter(tpsSettings), ['name', 'tps:apikey'])

                if (!tpsEnabled || !tpsUsername || !tpsApiKey) {
                    tpsEnabled = false
                } else {
                    tpsEnabled = tpsEnabled.value
                    tpsUsername = tpsUsername.value
                    tpsApiKey = tpsApiKey.value
                }

                async.parallel(
                    [
                        function (cb) {
                            if (ticket.owner._id.toString() === comment.owner.toString()) return cb
                            if (!_.isUndefined(ticket.assignee) && ticket.assignee._id.toString() === comment.owner.toString())
                                return cb

                            var notification = new NotificationSchema({
                                owner: ticket.owner,
                                title: 'Comment Added to Ticket#' + ticket.uid,
                                message: ticket.subject,
                                type: 1,
                                data: { ticket: ticket },
                                unread: true
                            })

                            notification.save(function (err) {
                                return cb(err)
                            })
                        },
                        function (cb) {
                            if (_.isUndefined(ticket.assignee)) return cb()
                            if (ticket.assignee._id.toString() === comment.owner.toString()) return cb
                            if (ticket.owner._id.toString() === ticket.assignee._id.toString()) return cb()

                            var notification = new NotificationSchema({
                                owner: ticket.assignee,
                                title: 'Comment Added to Ticket#' + ticket.uid,
                                message: ticket.subject,
                                type: 2,
                                data: { ticket: ticket },
                                unread: true
                            })

                            notification.save(function (err) {
                                return cb(err)
                            })
                        },
                        function (cb) {
                            sendPushNotification(
                                {
                                    tpsEnabled: tpsEnabled,
                                    tpsUsername: tpsUsername,
                                    tpsApiKey: tpsApiKey,
                                    hostname: hostname
                                },
                                { type: 2, ticket: ticket }
                            )
                            return cb()
                        },
                        // Send email to subscribed users
                        function (c) {
                            var emails = []
                            async.each(
                                ticket.subscribers,
                                function (member, cb) {
                                    // Send to owner
                                    if (ticket.owner.id !== comment.owner) {
                                        emails.push(ticket.owner.email);
                                    }

                                    if (_.isUndefined(member) || _.isUndefined(member.email)) return cb()
                                    if (member._id.toString() === comment.owner.toString()) return cb()
                                    if (member.deleted) return cb()

                                    emails.push(member.email)

                                    cb()
                                },
                                function (err) {
                                    if (err) return c(err)

                                    emails = _.uniq(emails)

                                    if (_.size(emails) < 1) {
                                        return c()
                                    }

                                    var mailJet = require('../mailer/mailJet')

                                    ticket.populate('comments.owner', function (err, t) {
                                        if (err) winston.warn(err)
                                        if (err) return c()

                                        let comments = _.sortBy(t.comments, function (o) { return moment(o.date); }).reverse()

                                        const formattedComments = comments.reduce(function (arr, comment) {
                                            var c = {
                                                owner: comment.owner,
                                                comment: comment.comment,
                                                date: moment(comment.date).format('MMMM Do YYYY, HH:mm:ss')
                                            };

                                            arr.push(c);

                                            return arr;
                                        }, []);

                                        mailJet.sendCommentAdded(t, formattedComments, emails)
                                    })
                                }
                            )
                        }
                    ],
                    function () {
                        // Blank
                    }
                )
            })
        })

        emitter.on('ticket:setAssignee', function (data) {
            settingsSchema.getSettingsByName(['tps:enable', 'tps:username', 'tps:apikey'], function (err, tpsSettings) {
                if (err) return false

                var tpsEnabled = _.head(_.filter(tpsSettings, ['name', 'tps:enable']))
                var tpsUsername = _.head(_.filter(tpsSettings, ['name', 'tps:username']))
                var tpsApiKey = _.head(_.filter(tpsSettings), ['name', 'tps:apikey'])

                if (!tpsEnabled || !tpsUsername || !tpsApiKey) {
                    tpsEnabled = false
                } else {
                    tpsEnabled = tpsEnabled.value
                    tpsUsername = tpsUsername.value
                    tpsApiKey = tpsApiKey.value
                }

                if (!tpsEnabled) return

                sendPushNotification(
                    {
                        tpsEnabled: tpsEnabled,
                        tpsUsername: tpsUsername,
                        tpsApiKey: tpsApiKey,
                        hostname: data.hostname
                    },
                    {
                        type: 4,
                        ticketId: data.ticketId,
                        ticketUid: data.ticketUid,
                        assigneeId: data.assigneeId
                    }
                )
            })
        })

        emitter.on('ticket:note:added', function (ticket) {
            // Goes to client
            io.sockets.emit('updateComments', ticket)
        })

        emitter.on('trudesk:profileImageUpdate', function (data) {
            io.sockets.emit('trudesk:profileImageUpdate', data)
        })

        emitter.on('$trudesk:flushRoles', function () {
            require('../permissions').register(function () {
                io.sockets.emit('$trudesk:flushRoles')
            })
        })
    })()
