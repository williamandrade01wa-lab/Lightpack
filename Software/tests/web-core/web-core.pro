QT = core gui testlib
TEMPLATE = app
CONFIG += console c++17 testcase
CONFIG -= app_bundle
TARGET = WebCoreTests
DESTDIR = bin

SOURCES += tst_WebCore.cpp \
           ../../src/compositor/Scenes.cpp \
           ../../src/compositor/Effects.cpp

HEADERS += ../../src/web/GroupValidation.hpp
