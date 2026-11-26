# User flows

Two people meet in a room. One creates it and sends an invite, the other joins, and either side can then send a file.
There are no accounts and nothing is stored on the server after the room ends. The labels below are the ones the
English page shows; the app is also available in Russian.

## Create a Room

The home page has the heading `Private File Transfer`, the `Create Room` button, the slider button labelled
`Create a Custom Room`, and the `Join a Room` form. The header holds the theme button, the `Settings` gear and the
`Language` select.

1. The user selects `Create Room`.
2. The status line says `Creating the room…` and then `Room ready. Send the invite link to the other person and keep
   this tab open.`
3. The room screen shows the `INVITE LINK` field, the `Copy Link` button, the `Show QR Code` button, the QR code and
   the `Send the keys separately instead` disclosure with `ACCESS KEY` and `SECRET KEY`.

The invite link is `<origin>/r/<accessKey>#<fragment>`. The 8-character access key is the room id the server sees. The
fragment holds the room hints and the secret. It never reaches the server. If the user selects `Copy Link`, the button
briefly reads `Copied`; if the clipboard is refused, the link is selected so it can be copied by hand.

The QR code shows the same link. `Show QR Code` and `Hide QR Code` toggle it at any width. The default for a new room
comes from `QR CODE ON A NEW ROOM` in Settings, which is set to `Show` or `Hide`.

The whole invite box disappears when the other person connects or when the room ends. The link field, the keys and the
QR leave the page, so the secret does not stay on screen after the pair is made.

## Invite

There are three ways to pass the invite to the other person:

- Send the link in any chat or mail program. The link contains the access key and the secret.
- Show the QR code so the other person can scan it with a phone.
- Open `Send the keys separately instead` and send `ACCESS KEY` and `SECRET KEY` as two separate values. The
  `SECRET KEY` field shows the whole fragment: two config characters followed by the 6-character secret. The joiner
  may type the fragment into the `SECRET KEY` field or the whole link into the `ACCESS KEY` field.

The creator's non-default room settings travel as hints in the fragment. They are hints only: the sealed messages sent
after the pair is made are what decide the room's behavior.

## Join

The joiner can open the link, scan the QR code, or type the keys on the home page. All three lead to the same
`Join room` screen.

### From a link

Opening the link loads the page, removes the fragment from the address bar and history, and opens the `Join room`
screen. Nothing connects until the user selects `Join`. `Cancel` and Escape return home without connecting.

### From a QR code

On a touch device whose browser supports camera access, the join form shows `Scan QR Code`. Selecting it opens the
`Scan the Invite` dialog
with the text `Point the camera at the QR code on the other screen.` The scanner accepts only an invite for the same
site. A different QR code shows `This QR code is not a e2ft invite for this site.` and scanning continues. A refused
camera shows `Camera access is blocked. Allow it in the browser's site settings, or paste the invite link instead.`
and a missing camera shows `No camera is available. Paste the invite link instead.` `Cancel`, Escape, success and
leaving the page all stop the camera.

### By typing the keys

The `Join a Room` form has `ACCESS KEY` and `SECRET KEY` fields. The access key is 8 letters or digits and the secret
is 6, or 8 with the room hints. Both are case-insensitive: the page converts them to upper case, drops spaces and
hyphens, reads `I` and `L` as `1`, and reads `O` as `0`. Pasting a whole invite link into `ACCESS KEY` fills both
fields. A malformed value shows `The access key is 8 letters or digits, the secret key 8 (or 6), in any case. Paste
them from the invite, or paste the whole invite link into Access Key.`

### The Join screen

The `Join room` screen shows the creator's non-default settings under `The creator set up this room:` as one or more
lines, for example `If a side drops, the room waits 15 min.`, `Relay only.`, `Relay only, over TCP.` or `Shares its
TURN server.` If the fragment's config characters cannot be read, the block says only `The room's settings are
unknown.` and the join still works. A default room has no non-default lines, so the block is not shown at all.

Under `YOUR CONNECTION` the joiner sets its own side of the connection for this room: `RELAY` is `Our servers` or
`My TURN server`, with `TURN URLS`, `USERNAME` and `PASSWORD` when an own TURN server is chosen. The same screen has
the `Use TURN` checkbox when it applies. These values apply to this room only and are not saved. If the invite says
the creator shares its TURN server, a `TURN SERVER` select offers `Use Theirs`, `Use Mine` or `Use Ours`, depending
on whether the joiner has its own TURN server.

Selecting `Join` starts the connection. `Cancel` and Escape go back home. The status line says `Joining the room…`
and then `Connecting to the other person…`. When the data channels open, both sides see `Connected. Choose a file to
send, or wait for one.` and the drop area appears.

If the room does not exist or has ended, the page says `Room not found. It ends when either person leaves, so ask for
a new invite.` A third person on a full room sees `Room is full. A room holds 2 people; ask for a new invite.` A wrong
secret shows `Wrong secret key: the other side has a different one. This room is closed; create a new one and send a
fresh invite.` on both sides.

## Find a device on your network

This is off by default. In `Settings`, `Visible to devices on my network` turns it on for this browser. The hint says
`Devices on the same network that also turned this on see each other on the home page and can start a room with a
tap. While it is off, this device neither shows nor sees others.` With it on, `DEVICE NAME` appears, prefilled with a
random name such as `Teal Otter`, with the note `The server sees this name and passes it to the devices on your
network.`

1. The home page shows `Devices on This Network` and the line `This device appears as <name>.` Each other visible
   device is a button with its name and its browser and system, for example `Firefox, Linux`. With none, the page says
   how to add one.
2. The user selects a device. The page says `Waiting for <name> to accept…`.
3. The other device shows `Start a Room?` with `<name> (<browser, system>) on your network wants to start a room with
   this device.` and the buttons `Decline` and `Accept`.
4. On `Decline`, the asking page says `The other device declined.` Without an answer it says `<name> did not answer.`
   after a minute. For 30 seconds after a decline, further asks from that device are declined without showing the
   dialog again.
5. On `Accept`, both pages open the room screen, without an invite, and show `Compare the Code` with a 6-digit code
   such as `493 201` and the buttons `No Match` and `It Matches`.
6. When both people select `It Matches`, the room connects and works like any other room.

If either person selects `No Match` or closes the dialog, the room ends. That page says `The codes did not match, so
the room is closed. Someone may be interfering with the connection. Try again, or use an invite link.` The other page
says `The other device did not confirm the code. The room is closed.` Only devices behind the same public address see
each other; a phone on mobile data does not see a laptop on Wi-Fi. A device that leaves the network can stay on the
others' lists for up to 40 seconds.

## Send a file

Once connected, the room shows `Choose a File or Drop It Here` with the hint `The other person accepts it before
anything is sent.` Clicking the area opens the file picker; dragging a file onto it drops the file into the same flow.
Only one file goes out at a time. A second file while one is still running shows `Wait until the current file is done
before sending another.`

The sender's status reads `Waiting for the other person to accept <name>…` and a `SENDING` row appears with the name
and `Cancel Sending`. Nothing is sent until the receiver accepts.

## Accept or decline

The receiver gets an `Incoming File` dialog with the file name, the size and the primary action button. The button is
`Save File…` when the browser has a save picker, `Download` when the file will be streamed or written to OPFS, and
`Receive` on iPhone and iPad. The hint below the name explains where the file will go:

- `Save it to choose where it goes. Nothing is sent until you do.`
- `It goes to your Downloads folder. Nothing is sent until you accept.`
- `It stays on this page until you tap Save in the list below, which opens the share sheet (Save Image, Save to
  Files).`

`Decline`, Escape and closing the dialog decline the offer. Accepting opens the save location and starts the
transfer. If the receiver already has a transfer running, or cannot save files, the offer is declined automatically
and the sender sees `The other person declined <name>.` A browser that can save nothing shows the notice
`The other person offered <name>, but this window can't save files (private windows can't). Open the invite in a
normal window or in Chrome. It was declined.` A file larger than the browser's storage limit shows the storage notice
and is declined.

After accepting, the receiver's status says `Receiving <name>…` and the sender's says `Sending <name>…`. When the whole
file is written, the receiver sees `Saved <name>.` and the sender sees `<name> was saved by the other person.` If the
receiver declines, the receiver sees `You declined <name>.` and the sender sees `The other person declined <name>.`
If the sender withdraws the offer with `Cancel Sending` before the answer, the receiver's dialog closes and the sender
sees `You cancelled <name>.`; the receiver sees `The other person withdrew <name>.`

## Where the file is saved

The save path is chosen from what the browser can do:

- Chromium-based desktop browsers: `Save File…` opens the system save picker. The user chooses the folder and name, and
  the file is written to disk while it arrives.
- Firefox and Safari with a controlling Service Worker: `Download` starts a streamed download in the browser's own
  download list. The download grows while the file arrives and ends in the Downloads folder.
- A browser with neither a save picker nor a controlling Service Worker: the file is first written to the origin
  private file system and then offered as a normal download when complete.
- iPhone and iPad: `Receive` keeps the file in the origin private file system. When the transfer ends, the status says
  `<name> received. Tap Save in the list below, then choose "Save to Files" to keep it.` The history row gets a `Save`
  button that opens the share sheet.
- A browser that cannot use any of these paths, such as some private windows, declines the offer with a notice.

Cancelling the download in the browser's own download list counts as cancelling the transfer.

## Progress and cancel

Each direction has its own row. `SENDING` and `RECEIVING` label the rows, and each row shows the file name, a progress
bar, `<done> of <total>`, the speed over the last few seconds and, after about 3 seconds of moving bytes, `<time> left`. The rows redraw
at most 4 times a second and the bar glides between redraws. When a row is paused it shows
`<done> of <total> · Paused, waiting for the connection…` and only the cancel button.

`Cancel Sending` and `Cancel Receiving` stop a transfer. The sender and the receiver both stop, a partial file is
removed, and the room stays usable for the next file. The cancelling side sees `You cancelled <name>.` and the other
side sees `The other person cancelled <name>.` A sender may cancel while the offer is still waiting, which closes the
receiver's dialog as described above.

Both directions can run at once, each with its own row. The `Connection Info` button opens the `Connection` dialog,
which says whether the path is direct over the local network, direct through NAT, or through the TURN relay, and shows
the candidate types, protocol and round-trip time, never addresses. While a transfer runs, it also says
`Sending over N connections.` or `Receiving over N connections.`

The `FILES IN THIS ROOM` list records each finished transfer once, newest first, with `Sent:` or `Received:` and
`Done`, `Declined`, `Cancelled` or `Failed`. The list lives only on the page and is gone when the page is left.

## The other side away and back

The room has a keep-alive, 5 minutes by default, set by the creator. If one page drops without leaving, the other side
hides the drop area and shows the warning `The other person is away (their page may be paused). The room waits
<MM:SS> for them to come back.` With animations on, a large `MM:SS` countdown runs beside the status line. `Leave Room`
stays available.

The page that lost its connection shows `Connection lost. Reconnecting…` and tries to take its seat back. It rejoins
at once and then with increasing delays, and it gives up only when the server refuses or after 30 minutes. A page that
was hidden for over a second and has no data channel also takes its seat back when it becomes visible again, because a
suspended page's socket can look open but be dead.

A transfer that was running when the connection dropped pauses on both sides. Its row shows `Paused` with
`Cancel Sending` or `Cancel Receiving`. The receiver keeps its file open and the sender keeps its `File`. When the
other side comes back, the transfer resumes from the first chunk the receiver has not written, with the same key and
the same transfer number, and nothing appears twice in history. A file that was fully sent but not acknowledged is
settled by `received` or `pending` messages after the reconnect. A cancel made while paused takes effect when the room
reconnects.

## Slow transfer: switch to Relay over TCP

Some networks slow down direct connections to a few hundred kB/s. A transfer can stay below 500 kB/s for 10 seconds
after its first 3 seconds, while its number of connections stays the same. When that happens, a card under the
transfer rows says `This transfer is slow. Some networks slow down direct connections, and relaying over TCP often gets
past that. The relay server would see both of your IP addresses.` and offers `Switch to Relay over TCP` and `Dismiss`.
The card appears at most once per room. It does not appear when the room is already Relay over TCP or when no TURN
server is configured.

`Switch to Relay over TCP` shows `Asked the other person to switch to Relay over TCP…` and opens the `Switch to Relay
over TCP?` dialog on the other side with `Decline` and `Accept`. On `Accept`, both sides show `Switching to Relay over
TCP…`. The room reconnects through the relay over TCP, a running transfer pauses briefly and then resumes, and the room
info line ends with `Relay only, over TCP.` Later reconnects in that room stay on Relay over TCP. On `Decline`, the
asking side sees `The other person kept the current connection.` After a decline or a `Dismiss`, the card does not
appear again in that room, reconnects included.

`?slow=1` shows the card as soon as a transfer runs, for trying the switch on a fast network.

If the away side does not return within the keep-alive, the server deletes the room. The side that was waiting sees
`The other person left. The room is deleted.` The returning side sees `The room is gone: the other person left, or one
of you was away too long.` A transfer that was paused fails on both sides and its partial file is removed.

On iPhone and iPad the room shows `On iPhone, Safari pauses this page when you switch apps or lock the phone. Come
back within a few minutes and the room reconnects; a file being sent then has to be sent again.` Reloading a page also
loses that page's seat, because the seat token is kept in memory only; the other side sees the seat go away and
eventually the room end.

## Leave and room end

`Leave Room` deletes the room immediately. The leaving side sees `You left the room. It is deleted.` The other side
sees `The other person left. The room is deleted.` Closing the tab, navigating to another page, following the header
logo home, or opening another invite in the same tab sends the same leave.

After the room ends, the button `Create a New Room` counts down from 10, showing `Create a New Room (10)` and so on,
then goes home. Clicking it earlier creates a room at once with the saved settings and a clean address bar. The
countdown does not start while the page holds unsaved iPhone files, because leaving the page would drop them.

An ended room cannot be joined again. A transfer that was running when the room ended appears as `Failed` in
history, and its partial file is removed.

## Settings

The `Settings` gear opens the saved defaults. The same dialog is prefilled for a custom room, and a third mode is the
`Join room` screen. The saved values live in the browser and are copied into each new room.

- `KEEP THE ROOM IF A SIDE DROPS` sets the keep-alive: `Off: end the room at once`, `1 min`, `5 min`, `15 min` or
  `30 min`. The default is 5 minutes. With `Off`, a dropped socket deletes the room at once.
- `RELAY` is `Our servers` or `My TURN server`. Choosing `My TURN server` shows `TURN URLS`, `USERNAME` and
  `PASSWORD`. The URLs must start with `turn:` or `turns:` and be separated by commas, and both the username and the
  password are required. Invalid values show `Enter one or more TURN URLs that start with turn: or turns:, separated
  by commas, and the username and password.` The hint says `Stays in this browser. Only your browser talks to this
  server.`
- `Share my TURN server with the other person` appears when `My TURN server` is chosen. It is off by default. The
  joiner receives the server end-to-end encrypted, for that room only, and the joiner never shows or saves it.
- `Always use TURN` sends this browser through the relay in every room and hides its IP address from the other person.
  It is off by default, applies only to this browser, and hides the IP only from the peer, not from the relay server.
  On the `Join room` screen the same checkbox is labelled `Use TURN` and applies to that room only.
- `QR CODE ON A NEW ROOM` is `Show` or `Hide` and sets whether the invite QR starts visible.
- `Disable animations` turns off the playful effects for transfers and room events. It is off by default. A browser
  that asks for reduced motion starts with animations off when the user has not saved a choice.
- `TRANSFER SPEED` is `Bytes per second (MB/s)` or `Bits per second (Mb/s)` and sets how a running transfer shows
  its speed. It is bytes by default and applies only to this browser. A click on a transfer's progress text, or Enter
  on it, switches the unit too, and the choice is kept.
- `Visible to devices on my network` and `DEVICE NAME` are described in "Find a device on your network". They are
  saved for this browser and are not part of a room's settings.
- `Notifications` asks for browser permission when it is ticked. If the browser blocks them, the dialog says
  `Notifications are blocked in this browser. Allow them in the site settings, then try again.` On the first home
  visit a card asks `Get a system notification when the other person joins, a file is offered or a transfer ends
  while you are in another tab?` with the buttons `Turn On` and `No Thanks`. Either answer is remembered.

`Save` stores the defaults; `Cancel` changes nothing. The room's own info line shows the keep-alive and which relay
this browser uses, for example `If a side drops, the room waits 5 min. Relay: our servers.` or `... Relay: your TURN
server.` or `... Relay: their TURN server.` It adds `Relay only.` or `Relay only, over TCP.` for a forced-relay room.
Changing the defaults does not change a room that is already open.

When the creator shares its TURN server, the joiner may be asked `Which TURN Server?` with `Use Theirs` and
`Use Mine` or `Use Ours`. The dialog warns that the creator's TURN server will see the joiner's IP address. Closing it
picks the joiner's own server, or ours. The answer is kept for that room, so a reconnect does not ask again. A joiner
in an Auto room with no own TURN server and no `Always use TURN` uses the shared one without being asked.

## Custom room

The slider button beside `Create Room`, labelled `Create a Custom Room`, opens the `Custom Room` dialog prefilled from
the saved defaults. Its values apply to that one room and are not saved. It has the keep-alive, the QR default, the
relay and own TURN fields, the share checkbox, and one extra field, `CONNECTION`:

- `Auto` connects directly and falls back to the relay.
- `Relay only` forces both sides through TURN.
- `Relay only, over TCP` forces TURN and moves every `turn:` URL to TCP.

The hint says `For both of you, this room only. Relay over TCP can get past networks that slow down calls and video.`
Selecting `Create Room` starts the room. The invitation carries the non-default keep-alive, relay mode and shared-TURN
hint as two config characters in the fragment, so the joiner's `Join room` screen can list them. The connection choice
itself is never saved.

## Theme and language

The header theme button cycles `Theme: Auto`, `Theme: Light` and `Theme: Dark` in its label and tooltip. `Auto`
follows the operating system; `Light` and `Dark` force a theme and are saved in the browser. A forced theme is applied
before the first paint, so the page does not flash the other theme.

The `Language` select offers `English` and `Русский`. On the first visit the page follows the browser language, falling
back to English. The choice is saved in the browser, and switching it re-renders the page, the current status and any
open dialog at once.

The footer shows the app version.
