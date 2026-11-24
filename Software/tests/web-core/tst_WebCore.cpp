#include <QtTest>
#include <QJsonDocument>

#include "../../src/compositor/Effects.hpp"
#include "../../src/compositor/Scenes.hpp"
#include "../../src/web/GroupValidation.hpp"

using namespace Compositor;

// Use escaped JSON literals so Qt 5 moc can parse the test slots.
class WebCoreTest : public QObject
{
	Q_OBJECT

private slots:
	void permitsSourceIgnoringCase()
	{
		const auto scene = QJsonDocument::fromJson("{\"triggers\":{\"allow\":[\"claude\"],\"target_groups\":[\"desk\"]}}").object();
		const auto policy = triggerPolicy(scene, QStringLiteral("CLAUDE"), 50);
		QVERIFY(!policy.suppressed);
		QCOMPARE(policy.targetGroups, QStringList{QStringLiteral("desk")});
	}

	void rejectsSourceOutsideAllowList()
	{
		const auto scene = QJsonDocument::fromJson("{\"triggers\":{\"allow\":[\"claude\"]}}").object();
		const auto policy = triggerPolicy(scene, QStringLiteral("system"), 100);
		QVERIFY(policy.suppressed);
		QCOMPARE(policy.reason, QStringLiteral("source"));
	}

	void checksPriorityAndPreservesLegacySource()
	{
		const auto scene = QJsonDocument::fromJson("{\"triggers\":{\"allow\":[\"claude\"],\"min_priority\":55}}").object();
		const auto policy = triggerPolicy(scene, QStringLiteral("claude"), 54);
		QVERIFY(policy.suppressed);
		QCOMPARE(policy.reason, QStringLiteral("priority"));
		QVERIFY(!triggerPolicy(scene, QStringLiteral("claude"), 55).suppressed);
		QVERIFY(!triggerPolicy(scene, QString(), 0).suppressed);
	}

	void acceptsWellFormedScene()
	{
		const auto scene = QJsonDocument::fromJson("{\"id\":\"work-1\",\"name\":\"Work\",\"groups\":[],\"triggers\":{\"allow\":[\"claude\"],\"min_priority\":100}}").object();
		QString error;
		QVERIFY2(validateSceneShape(scene, &error), qPrintable(error));
	}

	void rejectsMalformedScene()
	{
		QString error;
		const auto badId = QJsonDocument::fromJson("{\"id\":\"wrong id\"}").object();
		QVERIFY(!validateSceneShape(badId, &error));
		const auto badSource = QJsonDocument::fromJson("{\"id\":\"work\",\"triggers\":{\"allow\":[42]}}").object();
		QVERIFY(!validateSceneShape(badSource, &error));
	}

	void validatesPatternContext()
	{
		const auto wave = QJsonDocument::fromJson("{\"type\":\"wave\",\"color\":\"#aabbcc\"}").object();
		Pattern pattern;
		QString error;
		QVERIFY2(parsePattern(wave, &pattern, &error, true), qPrintable(error));
		QVERIFY(pattern.kind == Kind::Wave);
		QVERIFY(!parsePattern(wave, &pattern, &error, false));
	}

	void requiresTwoGradientStops()
	{
		const auto gradient = QJsonDocument::fromJson("{\"type\":\"gradient\",\"stops\":[{\"at\":0,\"color\":\"#aabbcc\"}]}").object();
		Pattern pattern;
		QString error;
		QVERIFY(!parsePattern(gradient, &pattern, &error, false));
	}

	void acceptsDisjointGroups()
	{
		const auto groups = QJsonDocument::fromJson("["
			"{\"id\":\"a\",\"leds\":{\"list\":[0]},\"mode\":{\"type\":\"source\"}},"
			"{\"id\":\"b\",\"leds\":{\"ranges\":[[1,2]]},\"mode\":{\"type\":\"off\"}}"
			"]").array();
		QCOMPARE(WebApi::validateGroups(groups, 3).status, 200);
	}

	void rejectsOverlappingGroups()
	{
		const auto groups = QJsonDocument::fromJson("["
			"{\"id\":\"a\",\"leds\":{\"all\":true},\"mode\":{\"type\":\"source\"}},"
			"{\"id\":\"b\",\"leds\":{\"list\":[1]},\"mode\":{\"type\":\"off\"}}"
			"]").array();
		const auto result = WebApi::validateGroups(groups, 3);
		QCOMPARE(result.status, 409);
		QCOMPARE(result.code, QStringLiteral("led_conflict"));
	}

	void rejectsOutOfRangeGroupLed()
	{
		const auto groups = QJsonDocument::fromJson("["
			"{\"id\":\"a\",\"leds\":{\"list\":[3]},\"mode\":{\"type\":\"source\"}}"
			"]").array();
		const auto result = WebApi::validateGroups(groups, 3);
		QCOMPARE(result.status, 400);
		QCOMPARE(result.code, QStringLiteral("invalid_leds"));
	}
};

QTEST_APPLESS_MAIN(WebCoreTest)
#include "tst_WebCore.moc"
