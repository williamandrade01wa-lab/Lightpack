/*
 * HttpApiServer.cpp
 *
 *	Project: Prismatik
 *
 *	Prismatik is free software: you can redistribute it and/or modify
 *	it under the terms of the GNU General Public License as published by
 *	the Free Software Foundation, either version 2 of the License, or
 *	(at your option) any later version.
 *
 */

#include "HttpApiServer.hpp"

#include "Settings.hpp"
#include "debug.h"
#include "enums.hpp"
#include "version.h"
#include "compositor/Effects.hpp"
#include "compositor/FrameCompositor.hpp"

#include <QDateTime>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QHostAddress>
#include <QJsonDocument>
#include <QRegularExpression>
#include <QTcpServer>
#include <QTcpSocket>
#include <QTimer>
#include <QUrl>
#include <QWebSocket>
#include <QWebSocketServer>

using namespace SettingsScope;
using namespace Compositor;

namespace
{
	const int MaxBodyBytes = 64 * 1024;
	const int MaxHeadBytes = 16 * 1024;
	const int MaxHttpConnections = 32;
	const int MaxWsClients = 8;
	const int MaxTriggersPerSecond = 30;
	const int ConnectionTimeoutMs = 10000;
	const int WsAuthTimeoutMs = 5000;
	const int WsMaxMessageBytes = 64 * 1024;
	const qint64 WsBackpressureBytes = 1024 * 1024;

	void addHeader(QList<QPair<QByteArray, QByteArray>> &list, const QByteArray &key, const QByteArray &value)
	{
		list.append(qMakePair(key, value));
	}

	QByteArray statusText(int status)
	{
		switch (status) {
		case 200: return "OK";
		case 202: return "Accepted";
		case 204: return "No Content";
		case 400: return "Bad Request";
		case 401: return "Unauthorized";
		case 403: return "Forbidden";
		case 404: return "Not Found";
		case 405: return "Method Not Allowed";
		case 409: return "Conflict";
		case 413: return "Payload Too Large";
		case 429: return "Too Many Requests";
		case 431: return "Request Header Fields Too Large";
		default: return "Internal Server Error";
		}
	}

	QByteArray contentTypeFor(const QString &path)
	{
		const QString p = path.toLower();
		if (p.endsWith(QLatin1String(".html")) || p.endsWith(QLatin1String(".htm"))) return "text/html; charset=utf-8";
		if (p.endsWith(QLatin1String(".js")) || p.endsWith(QLatin1String(".mjs"))) return "text/javascript; charset=utf-8";
		if (p.endsWith(QLatin1String(".css"))) return "text/css; charset=utf-8";
		if (p.endsWith(QLatin1String(".json"))) return "application/json; charset=utf-8";
		if (p.endsWith(QLatin1String(".svg"))) return "image/svg+xml";
		if (p.endsWith(QLatin1String(".png"))) return "image/png";
		if (p.endsWith(QLatin1String(".ico"))) return "image/x-icon";
		if (p.endsWith(QLatin1String(".woff2"))) return "font/woff2";
		return "application/octet-stream";
	}

	// constant-time comparison, so the token cannot be guessed byte by byte
	bool constantTimeEquals(const QByteArray &a, const QByteArray &b)
	{
		int diff = a.size() ^ b.size();
		const int n = qMax(a.size(), b.size());
		for (int i = 0; i < n; ++i) {
			const char ca = i < a.size() ? a[i] : 0;
			const char cb = i < b.size() ? b[i] : 0;
			diff |= (ca ^ cb);
		}
		return diff == 0;
	}

	QString compactJson(const QJsonValue &v)
	{
		return QString::fromUtf8(v.isArray() ? QJsonDocument(v.toArray()).toJson(QJsonDocument::Compact)
											 : QJsonDocument(v.toObject()).toJson(QJsonDocument::Compact));
	}

	const char *modeName(Lightpack::Mode mode)
	{
		switch (mode) {
		case Lightpack::AmbilightMode: return "ambilight";
		case Lightpack::MoodLampMode: return "moodlamp";
		case Lightpack::SoundVisualizeMode: return "sound";
		default: return "unknown";
		}
	}
}

HttpApiServer::HttpApiServer(const QString &configDir, QObject *parent)
	: QObject(parent)
	, m_configDir(configDir)
{
	m_triggerWindow.start();
}

HttpApiServer::~HttpApiServer()
{
	stop();
}

// ---------------------------------------------------------------------------
// life cycle

void HttpApiServer::start()
{
	stop();
	if (!Settings::isWebApiEnabled())
		return;

	m_port = Settings::getWebApiPort();
	m_allowLan = Settings::isWebApiLanAllowed();
	m_token = Settings::getWebApiToken();
	m_allowedOrigins = Settings::getWebApiAllowedOrigins();

	m_tcp = new QTcpServer(this);
	connect(m_tcp, &QTcpServer::newConnection, this, &HttpApiServer::onNewConnection);
	if (!m_tcp->listen(m_allowLan ? QHostAddress(QHostAddress::Any) : QHostAddress(QHostAddress::LocalHost), quint16(m_port))) {
		qWarning() << Q_FUNC_INFO << "web API: cannot listen on port" << m_port << m_tcp->errorString();
		delete m_tcp;
		m_tcp = nullptr;
		return;
	}

	// never listens by itself: connections are handed over after the HTTP head was checked
	m_ws = new QWebSocketServer(QStringLiteral("Prismatik"), QWebSocketServer::NonSecureMode, this);
#if QT_VERSION >= QT_VERSION_CHECK(5, 15, 0)
	m_ws->setMaxPendingConnections(MaxWsClients);
#endif
	connect(m_ws, &QWebSocketServer::newConnection, this, &HttpApiServer::onWsConnection);

	m_fpsClock.start();
	m_frameCount = 0;
	m_statsTimer = new QTimer(this);
	m_statsTimer->setInterval(1000);
	connect(m_statsTimer, &QTimer::timeout, this, &HttpApiServer::sendStats);
	m_statsTimer->start();

	DEBUG_LOW_LEVEL << Q_FUNC_INFO << "web API listening on port" << m_port << "lan" << m_allowLan;
}

void HttpApiServer::stop()
{
	if (m_statsTimer) {
		delete m_statsTimer;
		m_statsTimer = nullptr;
	}
	for (auto it = m_clients.begin(); it != m_clients.end(); ++it)
		if (it.key())
			it.key()->close();
	m_clients.clear();
	const QList<QTcpSocket *> sockets = m_conns.keys();
	m_conns.clear();
	for (QTcpSocket *s : sockets)
		if (s) {
			s->disconnect(this);
			s->abort();
			s->deleteLater();
		}
	if (m_ws) {
		delete m_ws;
		m_ws = nullptr;
	}
	if (m_tcp) {
		m_tcp->close();
		delete m_tcp;
		m_tcp = nullptr;
	}
}

// ---------------------------------------------------------------------------
// data pushed by the application

void HttpApiServer::onFrame(const QList<QRgb> &colors)
{
	++m_frameCount;
	if (!wsHasSubscribers(FrameChannel))
		return;
	QByteArray rgb;
	rgb.reserve(colors.size() * 3);
	for (QRgb c : colors) {
		rgb.append(char(qRed(c)));
		rgb.append(char(qGreen(c)));
		rgb.append(char(qBlue(c)));
	}
	QJsonObject msg;
	msg.insert(QStringLiteral("type"), QStringLiteral("frame"));
	msg.insert(QStringLiteral("t"), double(QDateTime::currentMSecsSinceEpoch()));
	msg.insert(QStringLiteral("leds"), colors.size());
	msg.insert(QStringLiteral("rgb"), QString::fromLatin1(rgb.toBase64()));
	wsBroadcast(compactJson(msg), FrameChannel);
}

void HttpApiServer::onOverlaysChanged(const QString &json)
{
	m_overlaysJson = json;
	QSet<QString> ids;
	QJsonObject byId;
	for (const QJsonValue &v : QJsonDocument::fromJson(json.toUtf8()).array()) {
		const QString id = v.toObject().value(QLatin1String("id")).toString();
		ids.insert(id);
		byId.insert(id, v);
	}
	for (const QString &id : ids)
		if (!m_overlayIds.contains(id))
			emitEvent(QStringLiteral("overlay.started"), byId.value(id).toObject());
	for (const QString &id : m_overlayIds)
		if (!ids.contains(id)) {
			QJsonObject o;
			o.insert(QStringLiteral("id"), id);
			emitEvent(QStringLiteral("overlay.ended"), o);
		}
	m_overlayIds = ids;
}

void HttpApiServer::setSerialMaxFps(double fps)
{
	m_serialMaxFps = fps;
}

void HttpApiServer::setScreensJson(const QString &json)
{
	m_screensJson = json;
}

void HttpApiServer::onProfileChanged(const QString &name)
{
	QJsonObject o;
	o.insert(QStringLiteral("profile"), name);
	emitEvent(QStringLiteral("profile.changed"), o);
}

void HttpApiServer::onStatusChanged(int status)
{
	m_status = status;
	QJsonObject o;
	o.insert(QStringLiteral("on"), status == Backlight::StatusOn || status == Backlight::StatusDeviceError);
	emitEvent(QStringLiteral("status.changed"), o);
}

// ---------------------------------------------------------------------------
// HTTP plumbing

void HttpApiServer::onNewConnection()
{
	while (m_tcp && m_tcp->hasPendingConnections()) {
		QTcpSocket *socket = m_tcp->nextPendingConnection();
		if (m_conns.size() >= MaxHttpConnections) {
			socket->abort();
			socket->deleteLater();
			continue;
		}
		Conn conn;
		conn.socket = socket;
		m_conns.insert(socket, conn);
		connect(socket, &QTcpSocket::readyRead, this, [this, socket]() { onSocketReadyRead(socket); });
		connect(socket, &QTcpSocket::disconnected, this, [this, socket]() {
			m_conns.remove(socket);
			socket->deleteLater();
		});
		QTimer::singleShot(ConnectionTimeoutMs, socket, [this, socket]() {
			if (m_conns.contains(socket))
				closeConn(socket);
		});
	}
}

void HttpApiServer::closeConn(QTcpSocket *socket)
{
	m_conns.remove(socket);
	socket->abort();
	socket->deleteLater();
}

void HttpApiServer::onSocketReadyRead(QTcpSocket *socket)
{
	auto it = m_conns.find(socket);
	if (it == m_conns.end() || socket->state() != QAbstractSocket::ConnectedState)
		return;
	Conn &conn = it.value();

	if (!conn.headParsed) {
		// peek only: a WebSocket upgrade must reach the WebSocket server with the data intact
		const QByteArray peeked = socket->peek(qMin<qint64>(socket->bytesAvailable(), MaxHeadBytes + 4));
		const int end = peeked.indexOf("\r\n\r\n");
		if (end < 0) {
			if (peeked.size() > MaxHeadBytes) {
				Request r;
				sendResponse(socket, errorResponse(431, QStringLiteral("header_too_large"), QStringLiteral("headers too large")), r);
			}
			return;
		}

		const QList<QByteArray> lines = peeked.left(end).split('\n');
		const QList<QByteArray> first = lines.value(0).trimmed().split(' ');
		Request request;
		if (first.size() != 3 || !first[2].startsWith("HTTP/1.")) {
			sendResponse(socket, errorResponse(400, QStringLiteral("bad_request"), QStringLiteral("malformed request line")), request);
			return;
		}
		request.method = first[0].toUpper();
		const QString target = QString::fromLatin1(first[1]);
		request.path = target.left(target.indexOf(QLatin1Char('?')) >= 0 ? target.indexOf(QLatin1Char('?')) : target.size());
		for (int i = 1; i < lines.size(); ++i) {
			const QByteArray line = lines[i].trimmed();
			const int colon = line.indexOf(':');
			if (colon > 0)
				request.headers.insert(line.left(colon).trimmed().toLower(), line.mid(colon + 1).trimmed());
		}

		if (request.headers.value("upgrade").toLower() == "websocket" && request.path == QLatin1String("/ws")) {
			handleWsUpgrade(socket, request);
			return;
		}

		socket->read(end + 4);
		bool ok = true;
		const QByteArray cl = request.headers.value("content-length");
		conn.contentLength = cl.isEmpty() ? 0 : cl.toLongLong(&ok);
		if (!ok || conn.contentLength < 0) {
			sendResponse(socket, errorResponse(400, QStringLiteral("bad_request"), QStringLiteral("bad Content-Length")), request);
			return;
		}
		if (conn.contentLength > MaxBodyBytes) {
			sendResponse(socket, errorResponse(413, QStringLiteral("body_too_large"), QStringLiteral("body larger than 64 KB")), request);
			return;
		}
		conn.request = request;
		conn.headParsed = true;
	}

	if (socket->bytesAvailable() < conn.contentLength)
		return;
	Request request = conn.request;
	request.body = socket->read(conn.contentLength);
	sendResponse(socket, route(request), request);
}

void HttpApiServer::sendResponse(QTcpSocket *socket, Response response, const Request &request)
{
	if (socket->state() != QAbstractSocket::ConnectedState)
		return; // already answered
	const QByteArray origin = request.headers.value("origin");
	if (!origin.isEmpty() && originAllowed(QString::fromLatin1(origin))) {
		addHeader(response.headers, "Access-Control-Allow-Origin", origin);
		addHeader(response.headers, "Vary", "Origin");
	}
	QByteArray out = "HTTP/1.1 " + QByteArray::number(response.status) + " " + statusText(response.status) + "\r\n";
	out += "Content-Type: " + response.contentType + "\r\n";
	out += "Content-Length: " + QByteArray::number(response.body.size()) + "\r\n";
	out += "Connection: close\r\n";
	out += "Cache-Control: no-store\r\n";
	out += "X-Content-Type-Options: nosniff\r\n";
	out += "X-Frame-Options: DENY\r\n";
	for (const auto &h : response.headers)
		out += h.first + ": " + h.second + "\r\n";
	out += "\r\n";
	if (request.method != "HEAD")
		out += response.body;
	socket->write(out);
	socket->disconnectFromHost();
}

bool HttpApiServer::hostAllowed(const QByteArray &host) const
{
	const QString h = QString::fromLatin1(host).toLower();
	const QString p = QString::number(m_port);
	return h == QLatin1String("127.0.0.1:") + p || h == QLatin1String("localhost:") + p || h == QLatin1String("[::1]:") + p;
}

bool HttpApiServer::originAllowed(const QString &origin) const
{
	const QString p = QString::number(m_port);
	const QString o = origin.toLower();
	if (o == QLatin1String("http://127.0.0.1:") + p || o == QLatin1String("http://localhost:") + p || o == QLatin1String("http://[::1]:") + p)
		return true;
	return m_allowedOrigins.contains(origin);
}

bool HttpApiServer::tokenValid(const QByteArray &authorization) const
{
	if (m_token.isEmpty() || !authorization.startsWith("Bearer "))
		return false;
	return constantTimeEquals(authorization.mid(7).trimmed(), m_token.toUtf8());
}

void HttpApiServer::handleWsUpgrade(QTcpSocket *socket, const Request &request)
{
	Request r = request;
	r.method = "GET";
	if ((!m_allowLan && !hostAllowed(request.headers.value("host"))) ) {
		sendResponse(socket, errorResponse(403, QStringLiteral("bad_host"), QStringLiteral("host not allowed")), r);
		return;
	}
	const QByteArray origin = request.headers.value("origin");
	if (!origin.isEmpty() && !originAllowed(QString::fromLatin1(origin))) {
		sendResponse(socket, errorResponse(403, QStringLiteral("bad_origin"), QStringLiteral("origin not allowed")), r);
		return;
	}
	if (m_clients.size() >= MaxWsClients) {
		sendResponse(socket, errorResponse(429, QStringLiteral("too_many_clients"), QStringLiteral("too many WebSocket clients")), r);
		return;
	}
	// hand over: the WebSocket server reads the still-unconsumed handshake
	m_conns.remove(socket);
	socket->disconnect(this);
	m_ws->handleConnection(socket);
}

// ---------------------------------------------------------------------------
// routing

HttpApiServer::Response HttpApiServer::jsonResponse(int status, const QJsonValue &value)
{
	Response r;
	r.status = status;
	r.body = compactJson(value).toUtf8();
	return r;
}

HttpApiServer::Response HttpApiServer::errorResponse(int status, const QString &code, const QString &message)
{
	QJsonObject e;
	e.insert(QStringLiteral("code"), code);
	e.insert(QStringLiteral("message"), message);
	QJsonObject o;
	o.insert(QStringLiteral("error"), e);
	return jsonResponse(status, o);
}

HttpApiServer::Response HttpApiServer::route(const Request &request)
{
	if (!m_allowLan && !hostAllowed(request.headers.value("host")))
		return errorResponse(403, QStringLiteral("bad_host"), QStringLiteral("host not allowed"));
	const QByteArray origin = request.headers.value("origin");
	if (!origin.isEmpty() && !originAllowed(QString::fromLatin1(origin)))
		return errorResponse(403, QStringLiteral("bad_origin"), QStringLiteral("origin not allowed"));

	if (request.method == "OPTIONS") {
		Response r;
		r.status = 204;
		addHeader(r.headers, "Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
		addHeader(r.headers, "Access-Control-Allow-Headers", "Authorization, Content-Type");
		addHeader(r.headers, "Access-Control-Max-Age", "600");
		return r;
	}

	const QString path = QUrl::fromPercentEncoding(request.path.toLatin1());
	if (path.startsWith(QLatin1String("/api/")) || path == QLatin1String("/api")) {
		if (!tokenValid(request.headers.value("authorization")))
			return errorResponse(401, QStringLiteral("unauthorized"), QStringLiteral("missing or invalid Bearer token"));
		QStringList parts;
		for (const QString &p : request.path.split(QLatin1Char('/')))
			if (!p.isEmpty())
				parts << QUrl::fromPercentEncoding(p.toLatin1());
		return routeApi(request, parts);
	}
	if (request.method != "GET" && request.method != "HEAD")
		return errorResponse(405, QStringLiteral("method_not_allowed"), QStringLiteral("method not allowed"));
	return serveStatic(path);
}

HttpApiServer::Response HttpApiServer::routeApi(const Request &request, const QStringList &parts)
{
	// parts: api, v1, ...
	if (parts.size() < 3 || parts[1] != QLatin1String("v1"))
		return errorResponse(404, QStringLiteral("not_found"), QStringLiteral("unknown API version"));
	const QStringList rest = parts.mid(2);
	const QString &what = rest[0];
	const QByteArray &m = request.method;

	if (what == QLatin1String("state") && rest.size() == 1)
		return handleState(request);
	if (what == QLatin1String("layout") && rest.size() == 1 && m == "GET")
		return handleLayout();
	if (what == QLatin1String("overlays") && rest.size() == 1 && m == "GET") {
		Response r;
		r.body = m_overlaysJson.toUtf8();
		return r;
	}
	if (what == QLatin1String("trigger"))
		return handleTrigger(request, rest);
	if (what == QLatin1String("profiles")) {
		if (rest.size() == 1 && m == "GET")
			return handleProfiles();
		if (rest.size() == 3 && rest[2] == QLatin1String("activate") && m == "POST") {
			if (!Settings::findAllProfiles().contains(rest[1]))
				return errorResponse(404, QStringLiteral("profile_not_found"), QStringLiteral("no such profile"));
			emit profileRequested(rest[1]);
			QJsonObject o;
			o.insert(QStringLiteral("profile"), rest[1]);
			return jsonResponse(200, o);
		}
		if (rest.size() >= 3 && rest[2] == QLatin1String("groups"))
			return handleGroups(request, rest);
	}
	return errorResponse(404, QStringLiteral("not_found"), QStringLiteral("unknown endpoint"));
}

HttpApiServer::Response HttpApiServer::serveStatic(const QString &rawPath)
{
	QString path = rawPath;
	if (path.contains(QLatin1String("..")) || path.contains(QLatin1Char('\\')) || path.contains(QChar(0)))
		return errorResponse(400, QStringLiteral("bad_path"), QStringLiteral("bad path"));
	if (path == QLatin1String("/"))
		path = QStringLiteral("/index.html");

	QByteArray data;
	bool found = false;
	const QString onDisk = m_configDir + QStringLiteral("/www") + path;
	if (QFileInfo(m_configDir + QStringLiteral("/www")).isDir()) {
		QFile f(onDisk);
		if (QFileInfo(f).isFile() && f.open(QIODevice::ReadOnly)) {
			data = f.readAll();
			found = true;
		}
	}
	if (!found) {
		QFile f(QStringLiteral(":/www") + path);
		if (f.open(QIODevice::ReadOnly)) {
			data = f.readAll();
			found = true;
		} else if (rawPath == QLatin1String("/")) {
			QFile t(QStringLiteral(":/www/test.html"));
			if (t.open(QIODevice::ReadOnly)) {
				data = t.readAll();
				path = QStringLiteral("/test.html");
				found = true;
			}
		}
	}
	if (!found)
		return errorResponse(404, QStringLiteral("not_found"), QStringLiteral("file not found"));

	Response r;
	r.contentType = contentTypeFor(path);
	// safe because of the Host check and no CORS: only pages served from this origin can read it
	if (path.endsWith(QLatin1String(".html")))
		data.replace("%%PRISMATIK_TOKEN%%", m_token.toUtf8());
	r.body = data;
	addHeader(r.headers, "Content-Security-Policy", "default-src 'self'; connect-src 'self' ws://127.0.0.1:" + QByteArray::number(m_port) + " ws://localhost:" + QByteArray::number(m_port) + "; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:");
	return r;
}

int HttpApiServer::ledCount() const
{
	return Settings::getNumberOfLeds(Settings::getConnectedDevice());
}

QJsonObject HttpApiServer::stateJson() const
{
	QJsonObject o;
	o.insert(QStringLiteral("on"), Settings::isBacklightEnabled());
	o.insert(QStringLiteral("profile"), Settings::getCurrentProfileName());
	o.insert(QStringLiteral("brightness"), Settings::getDeviceBrightness());
	o.insert(QStringLiteral("mode"), QString::fromLatin1(modeName(Settings::getLightpackMode())));
	o.insert(QStringLiteral("led_count"), ledCount());
	o.insert(QStringLiteral("device"), Settings::getConnectedDeviceName());
	o.insert(QStringLiteral("fps"), m_fps);
	o.insert(QStringLiteral("max_fps"), m_serialMaxFps);
	o.insert(QStringLiteral("version"), QStringLiteral(VERSION_STR));
	return o;
}

HttpApiServer::Response HttpApiServer::handleState(const Request &request)
{
	if (request.method == "GET")
		return jsonResponse(200, stateJson());
	if (request.method != "PATCH")
		return errorResponse(405, QStringLiteral("method_not_allowed"), QStringLiteral("use GET or PATCH"));

	const QJsonDocument doc = QJsonDocument::fromJson(request.body);
	if (!doc.isObject())
		return errorResponse(400, QStringLiteral("invalid_json"), QStringLiteral("body must be a JSON object"));
	const QJsonObject b = doc.object();
	QJsonObject state = stateJson();

	if (b.contains(QLatin1String("on")) && !b.value(QLatin1String("on")).isBool())
		return errorResponse(400, QStringLiteral("invalid_value"), QStringLiteral("on must be true or false"));
	if (b.contains(QLatin1String("profile"))) {
		if (!b.value(QLatin1String("profile")).isString() || !Settings::findAllProfiles().contains(b.value(QLatin1String("profile")).toString()))
			return errorResponse(404, QStringLiteral("profile_not_found"), QStringLiteral("no such profile"));
	}
	if (b.contains(QLatin1String("brightness"))) {
		const QJsonValue v = b.value(QLatin1String("brightness"));
		if (!v.isDouble() || v.toInt() < 0 || v.toInt() > 100)
			return errorResponse(400, QStringLiteral("invalid_value"), QStringLiteral("brightness must be 0..100"));
	}

	if (b.contains(QLatin1String("on"))) {
		const bool on = b.value(QLatin1String("on")).toBool();
		emit statusRequested(on ? Backlight::StatusOn : Backlight::StatusOff);
		state.insert(QStringLiteral("on"), on);
	}
	if (b.contains(QLatin1String("profile"))) {
		emit profileRequested(b.value(QLatin1String("profile")).toString());
		state.insert(QStringLiteral("profile"), b.value(QLatin1String("profile")).toString());
	}
	if (b.contains(QLatin1String("brightness"))) {
		emit brightnessRequested(b.value(QLatin1String("brightness")).toInt());
		state.insert(QStringLiteral("brightness"), b.value(QLatin1String("brightness")).toInt());
	}
	return jsonResponse(200, state);
}

HttpApiServer::Response HttpApiServer::handleProfiles()
{
	QJsonArray names;
	for (const QString &n : Settings::findAllProfiles())
		names.append(n);
	QJsonObject o;
	o.insert(QStringLiteral("current"), Settings::getCurrentProfileName());
	o.insert(QStringLiteral("profiles"), names);
	return jsonResponse(200, o);
}

HttpApiServer::Response HttpApiServer::handleLayout()
{
	const int n = ledCount();
	QJsonArray leds;
	for (int i = 0; i < n; ++i) {
		const QPoint p = Settings::getLedPosition(i);
		const QSize s = Settings::getLedSize(i);
		QJsonObject l;
		l.insert(QStringLiteral("index"), i);
		l.insert(QStringLiteral("x"), p.x());
		l.insert(QStringLiteral("y"), p.y());
		l.insert(QStringLiteral("w"), s.width());
		l.insert(QStringLiteral("h"), s.height());
		l.insert(QStringLiteral("enabled"), Settings::isLedEnabled(i));
		leds.append(l);
	}
	QJsonObject o;
	o.insert(QStringLiteral("led_count"), n);
	o.insert(QStringLiteral("leds"), leds);
	o.insert(QStringLiteral("screens"), QJsonDocument::fromJson(m_screensJson.toUtf8()).array());
	return jsonResponse(200, o);
}

// ---------------------------------------------------------------------------
// groups

QString HttpApiServer::resolveProfile(const QString &raw) const
{
	if (raw == QLatin1String("current"))
		return Settings::getCurrentProfileName();
	return Settings::findAllProfiles().contains(raw) ? raw : QString();
}

QString HttpApiServer::groupsJsonFor(const QString &profile) const
{
	auto it = m_groupsCache.find(profile);
	if (it != m_groupsCache.end() && it.value().age.isValid() && it.value().age.elapsed() < 3000)
		return it.value().json;
	return Settings::getProfileCompositorGroupsJson(profile);
}

QJsonArray HttpApiServer::groupsFor(const QString &profile) const
{
	return QJsonDocument::fromJson(groupsJsonFor(profile).toUtf8()).array();
}

void HttpApiServer::writeGroups(const QString &profile, const QJsonArray &groups)
{
	const QString json = groups.isEmpty() ? QString() : compactJson(groups);
	CachedGroups c;
	c.json = json;
	c.age.start();
	m_groupsCache.insert(profile, c);
	emit groupsWriteRequested(profile, json);
}

bool HttpApiServer::validateGroups(const QJsonArray &groups, Response *error) const
{
	static const QRegularExpression idRe(QStringLiteral("^[A-Za-z0-9_.-]{1,40}$"));
	const int n = ledCount();
	if (n <= 0 && !groups.isEmpty()) {
		*error = errorResponse(400, QStringLiteral("invalid_leds"), QStringLiteral("the device has no LEDs configured"));
		return false;
	}
	QVector<QString> owner(qMax(n, 0));
	QSet<QString> ids;
	for (const QJsonValue &v : groups) {
		if (!v.isObject()) {
			*error = errorResponse(400, QStringLiteral("invalid_group"), QStringLiteral("each group must be an object"));
			return false;
		}
		const QJsonObject o = v.toObject();
		const QString id = o.value(QLatin1String("id")).toString();
		if (!idRe.match(id).hasMatch()) {
			*error = errorResponse(400, QStringLiteral("invalid_group"), QStringLiteral("group id must be 1-40 letters, digits, '_', '.' or '-'"));
			return false;
		}
		if (ids.contains(id)) {
			*error = errorResponse(409, QStringLiteral("id_exists"), QStringLiteral("duplicate group id: ") + id);
			return false;
		}
		ids.insert(id);
		LedSet set;
		Pattern mode;
		QString err;
		if (!parseLedSet(o.value(QLatin1String("leds")).toObject(), &set, &err)) {
			*error = errorResponse(400, QStringLiteral("invalid_leds"), err);
			return false;
		}
		if (!parsePattern(o.value(QLatin1String("mode")).toObject(), &mode, &err, false)) {
			*error = errorResponse(400, QStringLiteral("invalid_mode"), err);
			return false;
		}
		QVector<int> indices;
		if (set.all) {
			for (int i = 0; i < n; ++i)
				indices.append(i);
		} else {
			indices = set.indices;
		}
		for (int i : indices) {
			if (i < 0 || (n > 0 && i >= n)) {
				*error = errorResponse(400, QStringLiteral("invalid_leds"), QStringLiteral("LED index out of range: %1 (0..%2)").arg(i).arg(n - 1));
				return false;
			}
			if (!owner[i].isEmpty() && owner[i] != id) {
				*error = errorResponse(409, QStringLiteral("led_conflict"), QStringLiteral("LED %1 is in groups '%2' and '%3'").arg(i).arg(owner[i], id));
				return false;
			}
			owner[i] = id;
		}
	}
	return true;
}

HttpApiServer::Response HttpApiServer::handleGroups(const Request &request, const QStringList &parts)
{
	// parts: profiles, {p}, groups[, {id}]
	const QString profile = resolveProfile(parts[1]);
	if (profile.isEmpty())
		return errorResponse(404, QStringLiteral("profile_not_found"), QStringLiteral("no such profile"));
	const QByteArray &m = request.method;
	QJsonArray groups = groupsFor(profile);
	Response err;

	if (parts.size() == 3) {
		if (m == "GET")
			return jsonResponse(200, groups);
		if (m == "PUT") {
			const QJsonDocument doc = QJsonDocument::fromJson(request.body);
			if (!doc.isArray())
				return errorResponse(400, QStringLiteral("invalid_json"), QStringLiteral("body must be a JSON array of groups"));
			if (!validateGroups(doc.array(), &err))
				return err;
			writeGroups(profile, doc.array());
			return jsonResponse(200, doc.array());
		}
		if (m == "POST") {
			const QJsonDocument doc = QJsonDocument::fromJson(request.body);
			if (!doc.isObject())
				return errorResponse(400, QStringLiteral("invalid_json"), QStringLiteral("body must be a group object"));
			groups.append(doc.object());
			if (!validateGroups(groups, &err))
				return err;
			writeGroups(profile, groups);
			return jsonResponse(200, doc.object());
		}
		return errorResponse(405, QStringLiteral("method_not_allowed"), QStringLiteral("method not allowed"));
	}

	if (parts.size() == 4) {
		const QString id = parts[3];
		int idx = -1;
		for (int i = 0; i < groups.size(); ++i)
			if (groups[i].toObject().value(QLatin1String("id")).toString() == id)
				idx = i;
		if (idx < 0)
			return errorResponse(404, QStringLiteral("group_not_found"), QStringLiteral("no such group"));
		if (m == "GET")
			return jsonResponse(200, groups[idx]);
		if (m == "DELETE") {
			groups.removeAt(idx);
			writeGroups(profile, groups);
			return jsonResponse(200, QJsonObject());
		}
		if (m == "PATCH") {
			const QJsonDocument doc = QJsonDocument::fromJson(request.body);
			if (!doc.isObject())
				return errorResponse(400, QStringLiteral("invalid_json"), QStringLiteral("body must be a JSON object"));
			QJsonObject merged = groups[idx].toObject();
			const QJsonObject patch = doc.object();
			for (auto it = patch.begin(); it != patch.end(); ++it)
				merged.insert(it.key(), it.value());
			groups[idx] = merged;
			if (!validateGroups(groups, &err))
				return err;
			writeGroups(profile, groups);
			return jsonResponse(200, merged);
		}
	}
	return errorResponse(405, QStringLiteral("method_not_allowed"), QStringLiteral("method not allowed"));
}

// ---------------------------------------------------------------------------
// triggers

bool HttpApiServer::allowTrigger()
{
	if (m_triggerWindow.elapsed() >= 1000) {
		m_triggerWindow.restart();
		m_triggersInWindow = 0;
	}
	return ++m_triggersInWindow <= MaxTriggersPerSecond;
}

HttpApiServer::Response HttpApiServer::doTrigger(QJsonObject trigger)
{
	if (!allowTrigger())
		return errorResponse(429, QStringLiteral("rate_limited"), QStringLiteral("more than 30 triggers per second"));
	if (trigger.value(QLatin1String("id")).toString().isEmpty())
		trigger.insert(QStringLiteral("id"), QStringLiteral("api-%1").arg(++m_idCounter));
	const QString json = compactJson(trigger);

	QString error;
	int durationMs = 0;
	if (!FrameCompositor::validateOverlayJson(json, &error, &durationMs))
		return errorResponse(400, QStringLiteral("invalid_trigger"), error);

	const QJsonObject target = trigger.value(QLatin1String("target")).toObject();
	if (target.contains(QLatin1String("groups"))) {
		QSet<QString> known;
		for (const QJsonValue &g : groupsFor(Settings::getCurrentProfileName()))
			known.insert(g.toObject().value(QLatin1String("id")).toString());
		for (const QJsonValue &g : target.value(QLatin1String("groups")).toArray())
			if (!known.contains(g.toString()))
				return errorResponse(400, QStringLiteral("unknown_group"), QStringLiteral("unknown group: ") + g.toString());
	}

	emit triggerRequested(json);
	QJsonObject o;
	o.insert(QStringLiteral("overlay_id"), trigger.value(QLatin1String("id")).toString());
	if (durationMs > 0)
		o.insert(QStringLiteral("expires_at_ms"), double(QDateTime::currentMSecsSinceEpoch() + durationMs));
	else
		o.insert(QStringLiteral("expires_at_ms"), QJsonValue::Null);
	return jsonResponse(202, o);
}

HttpApiServer::Response HttpApiServer::handleTrigger(const Request &request, const QStringList &parts)
{
	if (parts.size() == 1 && request.method == "POST") {
		const QJsonDocument doc = QJsonDocument::fromJson(request.body);
		if (!doc.isObject())
			return errorResponse(400, QStringLiteral("invalid_json"), QStringLiteral("body must be a JSON object"));
		return doTrigger(doc.object());
	}
	if (parts.size() == 2 && request.method == "DELETE") {
		emit removeRequested(parts[1]);
		QJsonObject o;
		o.insert(QStringLiteral("overlay_id"), parts[1]);
		return jsonResponse(200, o);
	}
	return errorResponse(405, QStringLiteral("method_not_allowed"), QStringLiteral("use POST /trigger or DELETE /trigger/{id}"));
}

// ---------------------------------------------------------------------------
// WebSocket

bool HttpApiServer::wsHasSubscribers(Channel channel) const
{
	for (const WsClient &c : m_clients) {
		if (!c.authed)
			continue;
		if ((channel == FrameChannel && c.frame) || (channel == StatsChannel && c.stats) || (channel == EventsChannel && c.events))
			return true;
	}
	return false;
}

void HttpApiServer::wsBroadcast(const QString &text, Channel channel)
{
	for (auto it = m_clients.begin(); it != m_clients.end(); ++it) {
		const WsClient &c = it.value();
		if (!c.authed)
			continue;
		if (!((channel == FrameChannel && c.frame) || (channel == StatsChannel && c.stats) || (channel == EventsChannel && c.events)))
			continue;
		QWebSocket *ws = it.key();
		// slow client: drop frames instead of piling them up
		if (channel == FrameChannel && ws->bytesToWrite() > WsBackpressureBytes)
			continue;
		ws->sendTextMessage(text);
	}
}

void HttpApiServer::sendStats()
{
	const double secs = qMax(1, int(m_fpsClock.restart())) / 1000.0;
	m_fps = m_frameCount / secs;
	m_frameCount = 0;
	if (!wsHasSubscribers(StatsChannel))
		return;
	QJsonObject msg;
	msg.insert(QStringLiteral("type"), QStringLiteral("stats"));
	msg.insert(QStringLiteral("fps"), m_fps);
	msg.insert(QStringLiteral("serial_max_fps"), m_serialMaxFps);
	msg.insert(QStringLiteral("overlays"), m_overlayIds.size());
	msg.insert(QStringLiteral("clients"), m_clients.size());
	wsBroadcast(compactJson(msg), StatsChannel);
}

void HttpApiServer::emitEvent(const QString &name, const QJsonObject &data)
{
	if (!wsHasSubscribers(EventsChannel))
		return;
	QJsonObject msg;
	msg.insert(QStringLiteral("type"), QStringLiteral("event"));
	msg.insert(QStringLiteral("event"), name);
	msg.insert(QStringLiteral("data"), data);
	wsBroadcast(compactJson(msg), EventsChannel);
}

void HttpApiServer::onWsConnection()
{
	while (m_ws && m_ws->hasPendingConnections()) {
		QWebSocket *ws = m_ws->nextPendingConnection();
		if (m_clients.size() >= MaxWsClients) {
			ws->close();
			ws->deleteLater();
			continue;
		}
#if QT_VERSION >= QT_VERSION_CHECK(5, 15, 0)
		ws->setMaxAllowedIncomingMessageSize(WsMaxMessageBytes);
#endif
		WsClient client;
		client.authTimer = new QTimer(ws);
		client.authTimer->setSingleShot(true);
		connect(client.authTimer, &QTimer::timeout, ws, [this, ws]() {
			if (m_clients.contains(ws) && !m_clients[ws].authed)
				ws->close(QWebSocketProtocol::CloseCodePolicyViolated, QStringLiteral("auth timeout"));
		});
		client.authTimer->start(WsAuthTimeoutMs);
		m_clients.insert(ws, client);

		connect(ws, &QWebSocket::textMessageReceived, this, [this, ws](const QString &text) { onWsMessage(ws, text); });
		connect(ws, &QWebSocket::binaryMessageReceived, ws, [ws]() {
			ws->close(QWebSocketProtocol::CloseCodeDatatypeNotSupported);
		});
		connect(ws, &QWebSocket::disconnected, this, [this, ws]() {
			m_clients.remove(ws);
			ws->deleteLater();
		});
	}
}

void HttpApiServer::onWsMessage(QWebSocket *ws, const QString &text)
{
	auto it = m_clients.find(ws);
	if (it == m_clients.end())
		return;
	WsClient &c = it.value();

	auto reply = [ws](const QJsonObject &o) { ws->sendTextMessage(compactJson(o)); };
	auto fail = [&](const QString &code, const QString &message) {
		QJsonObject o;
		o.insert(QStringLiteral("type"), QStringLiteral("error"));
		o.insert(QStringLiteral("code"), code);
		o.insert(QStringLiteral("message"), message);
		reply(o);
	};

	const QJsonDocument doc = QJsonDocument::fromJson(text.toUtf8());
	if (!doc.isObject()) {
		fail(QStringLiteral("invalid_json"), QStringLiteral("message must be a JSON object"));
		return;
	}
	const QJsonObject msg = doc.object();
	const QString type = msg.value(QLatin1String("type")).toString();

	if (!c.authed) {
		if (type != QLatin1String("auth") || !tokenValid("Bearer " + msg.value(QLatin1String("token")).toString().toUtf8())) {
			ws->close(QWebSocketProtocol::CloseCodePolicyViolated, QStringLiteral("unauthorized"));
			return;
		}
		c.authed = true;
		delete c.authTimer;
		c.authTimer = nullptr;
		QJsonObject ok;
		ok.insert(QStringLiteral("type"), QStringLiteral("auth_ok"));
		ok.insert(QStringLiteral("state"), stateJson());
		reply(ok);
		return;
	}

	if (type == QLatin1String("subscribe") || type == QLatin1String("unsubscribe")) {
		const bool on = type == QLatin1String("subscribe");
		for (const QJsonValue &v : msg.value(QLatin1String("channels")).toArray()) {
			const QString ch = v.toString();
			if (ch == QLatin1String("frame")) c.frame = on;
			else if (ch == QLatin1String("stats")) c.stats = on;
			else if (ch == QLatin1String("events")) c.events = on;
		}
		QJsonObject o;
		o.insert(QStringLiteral("type"), QStringLiteral("ok"));
		reply(o);
	} else if (type == QLatin1String("trigger")) {
		QJsonObject t = msg.contains(QLatin1String("trigger")) ? msg.value(QLatin1String("trigger")).toObject() : msg;
		t.remove(QStringLiteral("type"));
		const Response r = doTrigger(t);
		const QJsonObject body = QJsonDocument::fromJson(r.body).object();
		QJsonObject o;
		if (r.status == 202) {
			o = body;
			o.insert(QStringLiteral("type"), QStringLiteral("trigger_ok"));
			reply(o);
		} else {
			const QJsonObject e = body.value(QLatin1String("error")).toObject();
			fail(e.value(QLatin1String("code")).toString(), e.value(QLatin1String("message")).toString());
		}
	} else if (type == QLatin1String("untrigger")) {
		emit removeRequested(msg.value(QLatin1String("id")).toString());
		QJsonObject o;
		o.insert(QStringLiteral("type"), QStringLiteral("ok"));
		reply(o);
	} else {
		fail(QStringLiteral("unknown_type"), QStringLiteral("unknown message type"));
	}
}
