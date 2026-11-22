Feature: The Feed: my Inbox as cards, one after another
  As someone with many threads going at once
  I want my Inbox as cards I can read and answer one after another
  So I can get through what needs me without opening each thread

  # Experiment feed (runner/src/experiments/feed.md): the GPUI app only. The
  # Swift app is frozen and has no Feed. The mock's TB_MOCK_FEED demo has the
  # threads of the mockup Mike picked on 20 Nov (r3-c-status).

  Background:
    Given the app is connected to a runner with the demo threads
    When I open the Feed

  @inbox.feed @feed @swift-pending
  Scenario: Cards that need me come first, then the running ones, then the rest
    Then the Feed's card "Explain the Claude 5-hour limit" needs me
    And the Feed's card "Keep main green" is running
    And the Feed's card "Explain the Claude 5-hour limit" comes before "Keep main green"
    And the Feed's card "Keep main green" comes before "Bedtime Tube"
    And the Feed's card "Explain the Claude 5-hour limit" starts with "Explain the Claude 5-hour limit in the guide and FAQ"
    And the Feed's card "Browser pane: back button" starts with "Browser pane: back button"
    And the sidebar still shows the Inbox

  @inbox.feed @feed @swift-pending
  Scenario: Answering a card's question sends it to the thread
    Given the runner takes its time to change threads
    When I answer "Drop the idea" on the Feed's card "Explain the Claude 5-hour limit"
    Then the Feed's card "Explain the Claude 5-hour limit" is sending
    And the thread "Explain the Claude 5-hour limit" got "Drop the idea"

  @inbox.feed @feed @swift-pending
  Scenario: The fold opens a card's recent messages
    When I open the fold on the Feed's card "Bedtime Tube"
    Then the Feed's card "Bedtime Tube" says "Claude · 8 messages"
    And the Feed's card "Bedtime Tube" shows the message "Thanks, and check again tonight?"
    And the Feed's card "Bedtime Tube" has a reply box

  @inbox.feed @feed @swift-pending
  Scenario: Done shrinks a card to one line, and Undo brings it back
    When I mark the Feed's card "San Francisco hotel" Done
    Then the Feed's card "San Francisco hotel" is one line
    And the thread "San Francisco hotel" is archived
    When I undo the Feed's card "San Francisco hotel"
    Then the Feed's card "San Francisco hotel" is a card again

  @inbox.feed @feed @swift-pending
  Scenario: A reply from a card goes to its thread
    When I reply "Hold off till Monday" on the Feed's card "Browser pane: back button"
    Then the thread "Browser pane: back button" got "Hold off till Monday"

  @inbox.feed @feed @swift-pending
  Scenario: Open thread leaves the Feed for the thread
    When I open the fold on the Feed's card "Bedtime Tube"
    And I click "Open thread" on the Feed
    Then the open thread is "Bedtime Tube"

  # Mike, 22 Nov: a card whose request had a picture said "[Picture 1] on
  # mobile..." in words. It's his bubble's chip and tile now, read from the
  # thread's first message.
  @inbox.feed @feed @swift-pending
  Scenario: A picture in what I asked shows as it does in my message
    Then the Feed's card "Upload screen on mobile" shows 1 picture in what I asked
    When I click "Picture 1" on the Feed's card "Upload screen on mobile"
    Then the viewer shows picture 1 of 1 "progress-after.png"

  # For everyone (docs/protocol/threads.md): the demo's panel card has Claude
  # leading, Codex and Gemini answered, and Grok still thinking.
  @inbox.feed @feed @swift-pending
  Scenario: A question for everyone is one card with every lab's replies
    Then the Feed has one card "Touch ID release signing"
    And the Feed's card "Touch ID release signing" is for everyone
    And the Feed's card "Touch ID release signing" says where it's at "Grok is still thinking."
    When I open the fold on the Feed's card "Touch ID release signing"
    Then the Feed's card "Touch ID release signing" says "Claude, Codex, Gemini and Grok · 3 replies"
    And the Feed's card "Touch ID release signing" shows the message "Wait, but set a date. One good release, then revoke within a week so the old key doesn't hang around."
    And the Feed's card "Touch ID release signing" replies to "@everyone"

  @inbox.feed @feed @swift-pending
  Scenario: A reply to one lab goes to its thread alone
    When I reply "Only you, Codex: how sure are you?" to "@Codex" on the Feed's card "Touch ID release signing"
    Then Codex's thread on the Feed's card "Touch ID release signing" got "Only you, Codex: how sure are you?"

  @inbox.feed @feed @swift-pending
  Scenario: The box at the top starts a thread for everyone
    Given the runner takes its time to change threads
    When I start "Which of the two logos reads better small?" for everyone from the Feed
    Then the Feed is starting a thread
    And the Feed's card "Which of the two logos reads better small?" is for everyone
    And the Feed's card "Which of the two logos reads better small?" is asking "Claude, Codex, Gemini and Grok"

  @inbox.feed @feed @swift-pending
  Scenario: Ask the others puts a card's question to the other labs
    Then the Feed's card "Bedtime Tube" can ask the others
    When I ask the others on the Feed's card "Bedtime Tube"
    Then the Feed's card "Bedtime Tube" is for everyone
