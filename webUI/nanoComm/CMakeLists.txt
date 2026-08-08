# 3.16 kvuli Raspberry Pi OS - bookworm ma cmake 3.25, bullseye 3.18.
# Nic nize novejsi cmake nepotrebuje.
cmake_minimum_required(VERSION 3.16)

project(nanoComm CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Vypnout GNU rozsireni: kod je cisty C++20 a na jinem prekladaci to nema
# tise projit jen proto, ze GCC neco pridava navic.
set(CMAKE_CXX_EXTENSIONS OFF)

# Bez tohohle vyjde build spusteny rucne (cmake -B build) uplne bez
# optimalizaci. Na Raspberry to je rozdil, ktery je citit.
if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
    set(CMAKE_BUILD_TYPE Release CACHE STRING "Build type" FORCE)
endif()

add_executable(nanoComm main.cpp)

# std::thread a std::this_thread::sleep_for chteji na Linuxu pthread.
# Na Debianu/ARM se to bez tohohle neslinkuje.
find_package(Threads REQUIRED)
target_link_libraries(nanoComm PRIVATE Threads::Threads)

# nlohmann/json. Na Debianu je to balik nlohmann-json3-dev. Kdyz prijde
# i s cmake configem, pouzije se ten; jinac staci, ze je hlavicka v include
# ceste. Kdyz neni ani jedno, at to spadne tady se srozumitelnou hlaskou
# a ne az uprostred prekladu na "no such file or directory".
find_package(nlohmann_json 3.7.0 QUIET)

if(nlohmann_json_FOUND)
    target_link_libraries(nanoComm PRIVATE nlohmann_json::nlohmann_json)
    message(STATUS "nlohmann_json: nalezen pres find_package")
else()
    include(CheckIncludeFileCXX)
    check_include_file_cxx("nlohmann/json.hpp" HAVE_NLOHMANN_HEADER)

    if(NOT HAVE_NLOHMANN_HEADER)
        message(FATAL_ERROR
            "nlohmann/json.hpp nenalezen.\n"
            "  Debian / Raspberry Pi OS: sudo apt install nlohmann-json3-dev\n"
            "  Arch:                     sudo pacman -S nlohmann-json")
    endif()

    message(STATUS "nlohmann_json: pouziva se hlavicka z include cesty")
endif()

# GCC 8 (Debian buster) ma std::filesystem jeste v samostatne knihovne.
# Bookworm ma GCC 12, kde uz je v libstdc++, takze se tohle preskoci.
if(CMAKE_CXX_COMPILER_ID STREQUAL "GNU" AND CMAKE_CXX_COMPILER_VERSION VERSION_LESS 9)
    target_link_libraries(nanoComm PRIVATE stdc++fs)
    message(STATUS "GCC ${CMAKE_CXX_COMPILER_VERSION}: linkuji stdc++fs")
endif()

message(STATUS "nanoComm: ${CMAKE_SYSTEM_NAME}/${CMAKE_SYSTEM_PROCESSOR}, ${CMAKE_BUILD_TYPE}")
