Feature: Notes API
  The API answers signed requests and refuses the rest.

  Scenario: Listing notes
    Given an API token
    When the client lists the notes
    Then the answer is a list

  Scenario: Reading one note
    Given an API token
    When the client reads a note
    Then the answer is the note

  Scenario: A request without a token is refused
    When a client without a token lists the notes
    Then the API refuses it
