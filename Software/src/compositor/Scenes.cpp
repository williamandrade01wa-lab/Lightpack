/*
 * Scenes.cpp
 *
 *	Project: Prismatik
 *
 *	Prismatik is free software: you can redistribute it and/or modify
 *	it under the terms of the GNU General Public License as published by
 *	the Free Software Foundation, either version 2 of the License, or
 *	(at your option) any later version.
 *
 */

#include "Scenes.hpp"

#include <QJsonDocument>
#include <QJsonValue>
#include <QRegularExpression>

namespace
{
	// LED map of the default scenes (0-based): monitor 0-70, desk 71-158 left to right,
	// desk-center = the LEDs under the monitor (measured: 98-131)
	QJsonObject range(int first, int last)
	{
		QJsonArray r;
		r.append(first);
		r.append(last);
		QJsonArray ranges;
		ranges.append(r);
		QJsonObject leds;
		leds.insert(QStringLiteral("ranges"), ranges);
		return leds;
	}

	QJsonObject sourceMode(double brightness = 1.0)
	{
		QJsonObject m;
		m.insert(QStringLiteral("type"), QStringLiteral("source"));
		if (brightness < 1.0)
			m.insert(QStringLiteral("brightness"), brightness);
		return m;
	}

	QJsonObject solidMode(const QString &color, double brightness)
	{
		QJsonObject m;
		m.insert(QStringLiteral("type"), QStringLiteral("solid"));
		m.insert(QStringLiteral("color"), color);
		m.insert(QStringLiteral("brightness"), brightness);
		return m;
	}

	QJsonObject group(const QString &id, const QString &name, int first, int last, const QJsonObject &mode)
	{
		QJsonObject g;
		g.insert(QStringLiteral("id"), id);
		g.insert(QStringLiteral("name"), name);
		g.insert(QStringLiteral("leds"), range(first, last));
		g.insert(QStringLiteral("mode"), mode);
		return g;
	}

	QJsonArray deskGroups(const QJsonObject &endsMode, const QJsonObject &monitorMode)
	{
		QJsonArray groups;
		groups.append(group(QStringLiteral("monitor"), QStringLiteral("Monitor"), 0, 70, monitorMode));
		groups.append(group(QStringLiteral("desk-left"), QStringLiteral("Mesa: esquerda"), 71, 97, endsMode));
		groups.append(group(QStringLiteral("desk-center"), QStringLiteral("Mesa: centro"), 98, 131, sourceMode()));
		groups.append(group(QStringLiteral("desk-right"), QStringLiteral("Mesa: direita"), 132, 158, endsMode));
		return groups;
	}

	QJsonObject triggers(int minPriority)
	{
		QJsonArray allow;
		allow.append(QStringLiteral("claude"));
		allow.append(QStringLiteral("chatgpt"));
		allow.append(QStringLiteral("whatsapp"));
		allow.append(QStringLiteral("sistema"));
		QJsonArray target;
		target.append(QStringLiteral("desk-left"));
		target.append(QStringLiteral("desk-right"));
		QJsonObject t;
		t.insert(QStringLiteral("allow"), allow);
		t.insert(QStringLiteral("min_priority"), minPriority);
		t.insert(QStringLiteral("target_groups"), target);
		return t;
	}

	QJsonObject scene(const QString &id, const QString &name, const QJsonArray &groups, const QJsonObject &trig)
	{
		QJsonObject s;
		s.insert(QStringLiteral("id"), id);
		s.insert(QStringLiteral("name"), name);
		s.insert(QStringLiteral("groups"), groups);
		s.insert(QStringLiteral("triggers"), trig);
		return s;
	}
}

namespace Compositor
{

QJsonArray defaultScenes()
{
	const QString warm = QStringLiteral("#ff8c3a");
	QJsonArray scenes;
	// Trabalho: screen on the monitor (dimmed) and the desk center, warm ends that take the notifications
	scenes.append(scene(QStringLiteral("trabalho"), QStringLiteral("Trabalho"),
		deskGroups(solidMode(warm, 0.7), sourceMode(0.6)), triggers(0)));
	// Midia: everything follows the screen; only urgent notifications
	scenes.append(scene(QStringLiteral("midia"), QStringLiteral(u"M\u00eddia"),
		deskGroups(sourceMode(), sourceMode()), triggers(90)));
	// Foco: only the LEDs under the monitor follow the screen; dim static ends for notifications
	scenes.append(scene(QStringLiteral("foco"), QStringLiteral("Foco"),
		deskGroups(solidMode(warm, 0.35), sourceMode()), triggers(0)));
	return scenes;
}

QJsonArray scenesFromJson(const QString &json)
{
	const QString trimmed = json.trimmed();
	if (trimmed.isEmpty())
		return defaultScenes();
	const QJsonDocument doc = QJsonDocument::fromJson(trimmed.toUtf8());
	return doc.isArray() ? doc.array() : defaultScenes();
}

QJsonObject findScene(const QJsonArray &scenes, const QString &id)
{
	if (id.isEmpty())
		return QJsonObject();
	for (const QJsonValue &v : scenes)
		if (v.toObject().value(QLatin1String("id")).toString() == id)
			return v.toObject();
	return QJsonObject();
}

bool validateSceneShape(const QJsonObject &scene, QString *error)
{
	static const QRegularExpression idRe(QStringLiteral("^[A-Za-z0-9_.-]{1,40}$"));
	if (!idRe.match(scene.value(QLatin1String("id")).toString()).hasMatch()) {
		*error = QStringLiteral("scene id must be 1-40 letters, digits, '_', '.' or '-'");
		return false;
	}
	if (scene.contains(QLatin1String("name")) && (!scene.value(QLatin1String("name")).isString()
			|| scene.value(QLatin1String("name")).toString().size() > 60)) {
		*error = QStringLiteral("scene name must be a string of up to 60 characters");
		return false;
	}
	if (scene.contains(QLatin1String("groups")) && !scene.value(QLatin1String("groups")).isArray()) {
		*error = QStringLiteral("scene groups must be an array");
		return false;
	}
	if (!scene.contains(QLatin1String("triggers")))
		return true;
	if (!scene.value(QLatin1String("triggers")).isObject()) {
		*error = QStringLiteral("scene triggers must be an object");
		return false;
	}
	const QJsonObject t = scene.value(QLatin1String("triggers")).toObject();
	for (const char *key : { "allow", "target_groups" }) {
		const QJsonValue v = t.value(QLatin1String(key));
		if (v.isUndefined() || v.isNull())
			continue;
		if (!v.isArray()) {
			*error = QStringLiteral("triggers.%1 must be an array of strings").arg(QLatin1String(key));
			return false;
		}
		for (const QJsonValue &s : v.toArray())
			if (!s.isString() || s.toString().isEmpty() || s.toString().size() > 40) {
				*error = QStringLiteral("triggers.%1 must be an array of strings").arg(QLatin1String(key));
				return false;
			}
	}
	const QJsonValue p = t.value(QLatin1String("min_priority"));
	if (!p.isUndefined() && !p.isNull() && (!p.isDouble() || p.toDouble() < 0 || p.toDouble() > 100)) {
		*error = QStringLiteral("triggers.min_priority must be 0..100");
		return false;
	}
	return true;
}

TriggerPolicy triggerPolicy(const QJsonObject &scene, const QString &source, int priority)
{
	TriggerPolicy policy;
	const QJsonObject t = scene.value(QLatin1String("triggers")).toObject();
	for (const QJsonValue &v : t.value(QLatin1String("target_groups")).toArray())
		if (!v.toString().isEmpty())
			policy.targetGroups << v.toString();

	if (source.isEmpty() || scene.isEmpty())
		return policy;

	const QJsonArray allow = t.value(QLatin1String("allow")).toArray();
	if (!allow.isEmpty()) {
		bool allowed = false;
		for (const QJsonValue &v : allow)
			if (v.toString().compare(source, Qt::CaseInsensitive) == 0)
				allowed = true;
		if (!allowed) {
			policy.suppressed = true;
			policy.reason = QStringLiteral("source");
			return policy;
		}
	}
	if (priority < t.value(QLatin1String("min_priority")).toInt(0)) {
		policy.suppressed = true;
		policy.reason = QStringLiteral("priority");
	}
	return policy;
}

}
