@area:account
Feature: Sign in
  A person signs in with a magic link sent to their email.

  Scenario: The sign-in page loads
    When a visitor opens the sign-in page
    Then they see the email form

  @planned
  Scenario: Sign in with a passkey
    Waiting on: passkeys shipping in the dashboard.
    When a visitor signs in with a passkey
    Then they land on their organization
