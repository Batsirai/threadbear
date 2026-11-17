Feature: The setup cards on first launch
  As someone opening Threadbear for the first time
  I want a few small cards that find what's already on my Mac
  So most of setting up is one press each, before I see the app

  Background:
    Given the app is connected to a runner with the demo threads

  # A new install gets them by itself (tour.feature, "A new install gets the
  # setup cards"); Help brings them back. The whole run against a real dev
  # runner, sign-in and all, is desktop/scripts/hello-e2e.mjs.
  @tour.hello @swift-pending
  Scenario: The cards go one at a time, each with one thing to decide
    When I choose "Set Up Threadbear" from the menu bar
    Then the setup cards show "Hi, I'm Threadbear"
    When I go on in the setup cards
    Then the setup cards show "Your agents"
    And the agents card lists "alex@example.com" as signed in
    When I go on in the setup cards
    Then the setup cards show "Where threads start"
    When I go back in the setup cards
    Then the setup cards show "Your agents"

  @tour.hello @swift-pending
  Scenario: Esc puts the cards away for good
    When I choose "Set Up Threadbear" from the menu bar
    And I put the setup cards away
    Then no setup card shows

  @tour.hello @swift-pending
  Scenario: Not now on the last card leaves the first message written in a new thread
    When I choose "Set Up Threadbear" from the menu bar
    And I skip to the last setup card
    Then the setup cards show "Ready when you are"
    When I skip the setup card
    Then no setup card shows
    And the composer says "Make me a patch for this folder that adds a button saying hello, then tell me what you did."
