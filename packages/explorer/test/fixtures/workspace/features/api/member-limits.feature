@area:members
Feature: Member limits
  What a member of an organization may do with the organization itself depends on the
  permissions their role grants.

  Background:
    Given an organization with a member whose role has no organization permission

  Scenario Outline: A member without the permission cannot <attempt>
    Verifies that the API refuses the call and names the missing permission. Each row
    below is one attempt a member without the permission makes, and the permission
    the refusal names.

    When the member tries to <attempt>
    Then the API refuses it for lack of <permission>

    Examples:
      | attempt                      | permission            |
      | rename the organization      | org:manage_org        |
      | delete the organization      | org:manage_org        |
      | invite a member              | org:manage_members    |
      | remove a member              | org:manage_members    |
      | change a member's role       | org:manage_members    |
      | create a role                | org:manage_roles      |
      | delete a role                | org:manage_roles      |
      | create an API token          | org:manage_tokens     |
      | revoke an API token          | org:manage_tokens     |
      | read the audit log           | org:read_audit        |
      | export the audit log         | org:read_audit        |
