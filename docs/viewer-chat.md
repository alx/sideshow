# Viewer ↔ Pi chat (text loop)

The viewer is a two-way channel with the Pi session a viewer session is bound
to. You can talk to the agent from the browser and it talks back — and when a
message asks for a card change, the agent revises the card **and** replies in
the same thread.

There are two places to talk:

- **Card thread** — the comment box under any card. A message here is about
  that card.
- **Session-home chat** — the composer at the top of a session's timeline. A
  message here is general (no card), for anything about the session as a
  whole.

Both are the same mechanism underneath: a comment you post in the browser
(`author: "user"`) becomes an item in the **Pi inbox** of that session.

## The lifecycle

Every message you send carries a small chip that tracks where it is:

| Chip       | Meaning                                               |
| ---------- | ----------------------------------------------------- |
| `queued`   | Saved, waiting for the bound Pi to pick it up.        |
| `sent`     | A Pi session claimed it and has it as a prompt.       |
| `answered` | The agent replied in the thread — the loop is closed. |

The chip updates live (no reload). You don't have to watch it — but it's the
fastest way to know whether the agent got to your message yet.

## How it closes the loop

1. **You** post a comment (card thread or session-home chat). It appears
   instantly with `queued`.
2. The **Pi session** bound to that viewer session polls the inbox, claims the
   item (first Pi wins; a second Pi gets a 409 and skips), and reads it as a
   user message that carries a short contract:
   - fetch the current card before editing,
   - revise it in place with `sideshow_update_surface` (new card only if the
     request is additive),
   - **always** finish with `sideshow_reply_to_user` in the same thread (or the
     session-home chat for general messages).
3. That reply is a normal agent comment. The server sees an agent comment land
   in the thread and flips the item to `answered`.

Because the flip is driven by the _reply actually landing_, the chip only says
`answered` when there is a visible answer for you to read.

## Running it

- **Viewer** — the chat composer and chips ship in the viewer build; nothing
  to configure.
- **Pi side** — the `sideshow` extension starts an inbox poller in each new Pi
  session (3 s interval). Kill switch: `SIDESHOW_PI_INBOX=0`. Interval:
  `SIDESHOW_PI_INBOX_POLL_MS`.
- Only the Pi session whose remembered viewer session matches the message's
  session will claim its items, so several Pi sessions on different viewer
  sessions coexist without stepping on each other.

## Non-Pi sessions

A viewer session with no bound agent has no poller. The composer still works
as a plain comment (it just never leaves `queued`), and comments without a
`pi` state show no chip.
