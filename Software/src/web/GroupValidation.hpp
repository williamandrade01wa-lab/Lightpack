#pragma once

#include "../compositor/Effects.hpp"

#include <QJsonArray>
#include <QRegularExpression>
#include <QSet>

namespace WebApi
{
struct GroupValidation {
	int status{200};
	QString code;
	QString message;
};

// Validate before writing, with the configured LED count passed by the caller.
inline GroupValidation validateGroups(const QJsonArray &groups, int n)
{
	using namespace Compositor;
	static const QRegularExpression idRe(QStringLiteral("^[A-Za-z0-9_.-]{1,40}$"));
	if (n <= 0 && !groups.isEmpty()) {
		return { 400, QStringLiteral("invalid_leds"), QStringLiteral("the device has no LEDs configured") };
	}
	QVector<QString> owner(qMax(n, 0));
	QSet<QString> ids;
	for (const QJsonValue &v : groups) {
		if (!v.isObject()) {
			return { 400, QStringLiteral("invalid_group"), QStringLiteral("each group must be an object") };
		}
		const QJsonObject o = v.toObject();
		const QString id = o.value(QLatin1String("id")).toString();
		if (!idRe.match(id).hasMatch()) {
			return { 400, QStringLiteral("invalid_group"), QStringLiteral("group id must be 1-40 letters, digits, '_', '.' or '-'") };
		}
		if (ids.contains(id)) {
			return { 409, QStringLiteral("id_exists"), QStringLiteral("duplicate group id: ") + id };
		}
		ids.insert(id);
		LedSet set;
		Pattern mode;
		QString err;
		if (!parseLedSet(o.value(QLatin1String("leds")).toObject(), &set, &err)) {
			return { 400, QStringLiteral("invalid_leds"), err };
		}
		if (!parsePattern(o.value(QLatin1String("mode")).toObject(), &mode, &err, false)) {
			return { 400, QStringLiteral("invalid_mode"), err };
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
				return { 400, QStringLiteral("invalid_leds"), QStringLiteral("LED index out of range: %1 (0..%2)").arg(i).arg(n - 1) };
			}
			if (!owner[i].isEmpty() && owner[i] != id) {
				return { 409, QStringLiteral("led_conflict"), QStringLiteral("LED %1 is in groups '%2' and '%3'").arg(i).arg(owner[i], id) };
			}
			owner[i] = id;
		}
	}
	return {};
}
} // namespace WebApi
