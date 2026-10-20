@local @area:version
Feature: Version
  The command line tool prints its version.

  Scenario: The version prints
    When a person runs the tool with --version
    Then it prints its version on one line
