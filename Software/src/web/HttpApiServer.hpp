/*
 * HttpApiServer.hpp
 *
 *	Project: Prismatik
 *
 *	Local web server: REST API (/api/v1/...), WebSocket (/ws) and static files
 *	(panel, test page) on one port (default 127.0.0.1:3637).
 *
 *	HTTP is a minimal parser on QTcpServer (QtHttpServer needs Qt 6.4, but the
 *	Linux build uses Qt 5). A connection that asks for "Upgrade: websocket" on /ws
 *	is handed to a QWebSocketServer that never listens by itself.
 *
 *	Security: loopback only by default, Bearer token on /api and in the first
 *	WebSocket message, Host check (DNS rebinding), Origin check (CSRF), size and
 *	connection limits, trigger rate limit.
 *
 *	The object lives in its own thread. It reads Settings (read only) and sends
 *	every change back through signals that the application connects (queued) to
 *	slots in the GUI thread.
 *
 *	Prismatik is free software: you can redistribute it and/or modify
 *	it under the terms of the GNU General Public License as published by
 *	the Free Software Foundation, either version 2 of the License, or
 *	(at your option) any later version.
 *
 */

#pragma once

#include <QByteArray>
#include <QElapsedTimer>
#include <QHash>
#include <QJsonArray>
#include <QJsonObject>
#include <QList>
#include <QObject>
#include <QPair>
#include <QPointer>
#include <QRgb>
#include <QSet>
#include <QStringList>

class QTcpServer;
class QTcpSocket;
class QTimer;
class QWebSocket;
class QWebSocketServer;

class HttpApiServer : public QObject
{
	Q_OBJECT
public:
	explicit HttpApiServer(const QString &configDir, QObject *parent = nullptr);
	~HttpApiServer();

public slots:
	// (re)create the listeners from Settings; call it in the server thread
	void start();
	void stop();

	// data pushed by the application
	void onFrame(const QList<QRgb> &colors);
	void onOverlaysChanged(const QString &json);
	void setSerialMaxFps(double fps);
	void setScreensJson(const QString &json);
	void onProfileChanged(const QString &name);
	void onStatusChanged(int status);

signals:
	// requests for the GUI thread
	void profileRequested(const QString &name);
	void statusRequested(int status);
	void brightnessRequested(int value);
	void groupsWriteRequested(const QString &profile, const QString &json);
	void triggerRequested(const QString &json);
	void removeRequested(const QString &id);

private:
	struct Request {
		QByteArray method;
		QString path;
		QHash<QByteArray, QByteArray> headers; // lower case names
		QByteArray body;
	};

	struct Response {
		int status{ 200 };
		QByteArray contentType{ "application/json; charset=utf-8" };
		QByteArray body;
		QList<QPair<QByteArray, QByteArray>> headers;
	};

	struct Conn {
		QPointer<QTcpSocket> socket;
		bool headParsed{ false };
		qint64 contentLength{ 0 };
		Request request;
	};

	struct WsClient {
		bool authed{ false };
		bool frame{ false };
		bool stats{ false };
		bool events{ false };
		QTimer *authTimer{ nullptr };
	};

	// HTTP plumbing
	void onNewConnection();
	void onSocketReadyRead(QTcpSocket *socket);
	void closeConn(QTcpSocket *socket);
	void sendResponse(QTcpSocket *socket, Response response, const Request &request);
	bool hostAllowed(const QByteArray &host) const;
	bool originAllowed(const QString &origin) const;
	bool tokenValid(const QByteArray &authorization) const;
	void handleWsUpgrade(QTcpSocket *socket, const Request &request);

	// routing
	Response route(const Request &request);
	Response routeApi(const Request &request, const QStringList &parts);
	Response serveStatic(const QString &path);
	Response handleState(const Request &request);
	Response handleGroups(const Request &request, const QStringList &parts);
	Response handleTrigger(const Request &request, const QStringList &parts);
	Response handleLayout();
	Response handleProfiles();
	QJsonObject stateJson() const;

	// helpers
	static Response jsonResponse(int status, const QJsonValue &value);
	static Response errorResponse(int status, const QString &code, const QString &message);
	QString resolveProfile(const QString &raw) const;           // "" = unknown
	QString groupsJsonFor(const QString &profile) const;
	QJsonArray groupsFor(const QString &profile) const;
	void writeGroups(const QString &profile, const QJsonArray &groups);
	bool validateGroups(const QJsonArray &groups, Response *error) const;
	bool allowTrigger();
	Response doTrigger(QJsonObject trigger);
	int ledCount() const;

	// WebSocket
	void onWsConnection();
	void onWsMessage(QWebSocket *ws, const QString &text);
	enum Channel { FrameChannel, StatsChannel, EventsChannel };
	void wsBroadcast(const QString &text, Channel channel);
	bool wsHasSubscribers(Channel channel) const;
	void sendStats();
	void emitEvent(const QString &name, const QJsonObject &data);

	QString m_configDir;
	QTcpServer *m_tcp{ nullptr };
	QWebSocketServer *m_ws{ nullptr };
	QTimer *m_statsTimer{ nullptr };
	QHash<QTcpSocket *, Conn> m_conns;
	QHash<QWebSocket *, WsClient> m_clients;

	int m_port{ 3637 };
	bool m_allowLan{ false };
	QString m_token;
	QStringList m_allowedOrigins;

	// state pushed by the app / measured here
	QString m_overlaysJson{ QStringLiteral("[]") };
	QSet<QString> m_overlayIds;
	QString m_screensJson{ QStringLiteral("[]") };
	double m_serialMaxFps{ 0.0 };
	int m_frameCount{ 0 };
	double m_fps{ 0.0 };
	int m_status{ 0 };
	QElapsedTimer m_fpsClock;
	QElapsedTimer m_triggerWindow;
	int m_triggersInWindow{ 0 };
	int m_idCounter{ 0 };

	// groups written through the API and not yet visible in the settings file
	struct CachedGroups { QString json; QElapsedTimer age; };
	mutable QHash<QString, CachedGroups> m_groupsCache;
};
