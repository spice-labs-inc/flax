@area:roles
Feature: Roles
  Roles bundle permissions; a short-lived access pass carries a role's permissions but never changes roles.

  Scenario: A role lists its permissions
    Given an organization with a custom role
    When the client reads the role
    Then the answer lists each permission once

  Scenario Outline: A Access Pass cannot <attempt>
    When a client with an access pass tries to <attempt>
    Then the API refuses it

    Examples:
      | attempt       |
      | create a role |
      | delete a role |
