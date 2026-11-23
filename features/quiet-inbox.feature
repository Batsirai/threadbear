Feature: Quietly archived threads
  As someone whose finished threads mostly just say they did what I asked
  I want the ones a model is sure I didn't need to see to skip my inbox
  So I only open the threads that have something for me, and can still check what was hidden

  # Experiment quietInboxMine (docs/protocol/threads.md, "Inbox guess"): the
  # runner archives the thread; the GPUI app counts and lists them. The Swift
  # app is frozen and shows them as plain archived threads.

  Background:
    Given the app is connected to a runner with the demo threads
    And the quiet inbox archived "Rename the Settings tabs" and "Morning brief" today

  @sidebar.quiet @swift-pending
  Scenario: The foot of the Inbox counts what was hidden today, and lists it newest first
    Then the foot of the Inbox says "Quietly archived: 2 today"
    When I open the quietly archived list
    Then the quietly archived list is "Rename the Settings tabs", "Morning brief"

  @sidebar.quiet @swift-pending
  Scenario: Should have shown me brings a thread back to the inbox at once
    When I open the quietly archived list
    And I press Should have shown me on "Morning brief"
    Then the "Inbox" section lists "Morning brief"
    And the foot of the Inbox says "Quietly archived: 1 today"
    And the runner was told I should have been shown "Morning brief"

  @sidebar.quiet @swift-pending
  Scenario: A refused Should have shown me puts the thread back where it was, with the error
    Given the runner will refuse the next Should have shown me
    When I open the quietly archived list
    And I press Should have shown me on "Morning brief"
    Then the error bar says "Couldn't bring it back just now. Try again in a moment."
    And the quietly archived list is "Rename the Settings tabs", "Morning brief"
