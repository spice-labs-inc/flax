Feature: Adding notes

  Background:
    Given the notes page is open

  Scenario: Add a note
    Given the list starts empty
    When I type "Weekly plan" as the title
    And I save the note
    Then the list shows "Weekly plan"
    When I list the notes from the terminal
    Then the terminal shows "Weekly plan"
    And the heading reads "Notebook"

  Scenario: Add a note that never shows
    When I type "Lost note" as the title
    Then the list shows "Some other note"

  Scenario: Not filmed
    Then the list is empty
