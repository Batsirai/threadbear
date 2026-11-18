Feature: Pull requests open beside the thread
  As someone deciding on other people's pull requests
  I want a PR link to open beside the thread with its checks, diff and buttons
  So I can decide and act without going out to the browser

  # Experiment inlinePrs (docs/protocol.md, "Pull requests"): the GPUI app
  # only. The Swift app is frozen and opens PR links in the browser.

  Background:
    Given the app is connected to a runner with the demo threads
    And I open the thread "Make uploads resume after a crash"

  @pane.prs @inline-prs @swift-pending
  Scenario: A PR link opens as a tab with what decides it
    When I follow the PR link "https://github.com/acme/app/pull/72/files" in the thread
    Then the pane shows the PR "Fewer approvals when a fork brings in a release"
    And the PR's status reads "Open"
    And the PR's checks read "1 of 2 passed" with "Windows failed"
    And the PR's activity includes "Thanks, looking now."

  @pane.prs @inline-prs @swift-pending
  Scenario: The diff tab lists the changed files
    When I follow the PR link "https://github.com/acme/app/pull/72" in the thread
    And I press "Diff" in the PR tab
    Then the PR tab is on "Diff"
    And the PR lists the file "runner/src/swift-changes.ts"

  @pane.prs @inline-prs @swift-pending
  Scenario: Closing it shows at once, then the PR reads closed
    When I follow the PR link "https://github.com/acme/app/pull/72" in the thread
    And I press the PR's button "Closes the PR on GitHub"
    Then the PR's button "close" is busy
    And the PR's status reads "Closed"
