Feature: Notes

  Background:
    Given the notes page is open

  @capture
  Scenario: Add a note
    When I type "Weekly plan" as the title
    And I save the note
    Then the list shows "Weekly plan"

  @capture:notes-heading @daily
  Scenario: The heading
    Then the heading reads "Notes"

  Scenario: Not captured
    Then the list is empty
