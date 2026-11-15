/*
 * Scenes.hpp
 *
 *	Project: Prismatik
 *
 *	Scenes ("modes" in the UI): named sets of compositor groups plus a trigger
 *	policy, stored per profile (Compositor/Scenes, JSON array) with the active
 *	one in Compositor/ActiveScene. Activating a scene copies its groups into
 *	Compositor/Groups; the capture keeps running.
 *
 *	  [{"id": "trabalho", "name": "Trabalho", "groups": [ ...same format as Compositor/Groups... ],
 *	    "triggers": {"allow": ["claude", "chatgpt"], "min_priority": 0, "target_groups": ["desk-left", "desk-right"]}}]
 *
 *	Prismatik is free software: you can redistribute it and/or modify
 *	it under the terms of the GNU General Public License as published by
 *	the Free Software Foundation, either version 2 of the License, or
 *	(at your option) any later version.
 *
 */

#pragma once

#include <QJsonArray>
#include <QJsonObject>
#include <QString>
#include <QStringList>

namespace Compositor
{
	// built-in scenes used while the profile has none saved (trabalho, midia, foco)
	QJsonArray defaultScenes();

	// stored value of Compositor/Scenes; empty or not a JSON array = defaultScenes()
	QJsonArray scenesFromJson(const QString &json);

	// the scene with this id, or an empty object
	QJsonObject findScene(const QJsonArray &scenes, const QString &id);

	// checks id, name and the "triggers" block (groups are checked by the caller,
	// which knows the LED count)
	bool validateSceneShape(const QJsonObject &scene, QString *error);

	struct TriggerPolicy {
		bool suppressed{ false };
		QString reason;            // "source" or "priority" when suppressed
		QStringList targetGroups;  // where triggers without a target light up
	};

	// Policy of `scene` for a trigger. Only triggers that name a `source` are filtered
	// (manual tests and the legacy TCP API always pass); an empty "allow" accepts any source.
	TriggerPolicy triggerPolicy(const QJsonObject &scene, const QString &source, int priority);
}
