Feature: Sign in
  A person signs in with their email.

  Scenario: The sign-in page loads
    When a visitor opens the sign-in page
    Then they see the sign-in form

  @planned
  Scenario: Sign in with a passkey
    Waiting on: passkeys shipping in the web app.
    When a visitor signs in with a passkey
    Then they land on the notes list
