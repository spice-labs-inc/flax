Feature: Notes
  A person writes notes and finds them again.

  Scenario: The notes list opens
    Given a signed-in writer
    When they open the notes list
    Then they see the list page

  Scenario: A note is created and saved
    Given a signed-in writer
    When they open the notes list
    And they press new note
    And they save the note
    Then the note page shows the note

  @admin
  Scenario: The admin page lists every account
    Given a signed-in administrator
    When they open the admin page
    Then they see every account
