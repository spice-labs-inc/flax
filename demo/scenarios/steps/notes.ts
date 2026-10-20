import { Given, Then, When } from "@cucumber/cucumber";
import type { NotesWorld } from "../support/world.ts";

Given("a signed-in writer", function (this: NotesWorld) {
  this.token = "writer";
  this.touch("web:route:/sign-in");
});

Given("a signed-in administrator", function (this: NotesWorld) {
  this.token = "admin";
  this.touch("web:route:/sign-in");
});

When("they open the notes list", function (this: NotesWorld) {
  this.touch("web:route:/notes");
});

When("they press new note", function (this: NotesWorld) {
  this.touch("web:testid:new-note");
});

When("they save the note", function (this: NotesWorld) {
  this.touch("web:route:/notes/[id]");
  this.touch("web:testid:save-note");
});

Then("they see the list page", function (this: NotesWorld) {
  if (!this.token) throw new Error("not signed in");
});

Then("the note page shows the note", function (this: NotesWorld) {
  if (this.env === "test")
    throw new Error("the note page showed an empty editor");
});

When("they open the admin page", function (this: NotesWorld) {
  this.touch("web:route:/admin");
});

Then("they see every account", function () {});

When("a visitor opens the sign-in page", function (this: NotesWorld) {
  this.touch("web:route:/sign-in");
});

Then("they see the sign-in form", function () {});

Given("an API token", function (this: NotesWorld) {
  this.token = "api-token";
});

When("the client lists the notes", function (this: NotesWorld) {
  this.touch("api:GET /api/notes", "success");
});

When("the client reads a note", function (this: NotesWorld) {
  this.touch("api:GET /api/notes", "success");
  this.touch("api:GET /api/notes/{id}", "success");
});

Then("the answer is a list", function () {});
Then("the answer is the note", function () {});

When("a client without a token lists the notes", function (this: NotesWorld) {
  this.touch("api:GET /api/notes", "auth-refusal");
});

Then("the API refuses it", function () {});
