cmake_minimum_required(VERSION 3.16)
project(Stroke2VibeAuto CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(MSVC)
    add_compile_options(/W4 /EHsc /O2)
else()
    add_compile_options(-Wall -Wextra -O2)
endif()

add_executable(Stroke2VibeAuto Stroke2VibeAuto.cpp)

enable_testing()
add_test(NAME functional_tests
         COMMAND ${CMAKE_SOURCE_DIR}/tests/run_tests.sh
         WORKING_DIRECTORY ${CMAKE_SOURCE_DIR}/tests)
