# User guide

Pellet Pace times shooting range events from one shared start. The host starts the clock for
everyone at once. Each shooter presses **STOP** on their own phone or tablet when they finish, and the
leaderboard updates live.

- [Getting connected](#getting-connected)
- [Accounts and roles](#accounts-and-roles)
- [For shooters](#for-shooters)
- [For hosts](#for-hosts)
- [For admins](#for-admins)
- [How timing works](#how-timing-works)
- [FAQ](#faq)

## Getting connected

1. Join the same Wi-Fi network as the range's Pellet Pace machine.
2. Open the address you were given, e.g. `https://192.168.1.20:3000`.
3. The first time, the browser warns that the connection is not private. This is expected: the range
   uses its own certificate. Choose **Advanced → Proceed** (Chrome/Android), **Show Details → visit this
   website** (Safari/iOS) or **Advanced → Accept the Risk** (Firefox).

Tip: add the page to your home screen, or bookmark it, so you can find it next time.

## Accounts and roles

| Role | Can do | How to get the account |
| --- | --- | --- |
| **Shooter** | Join events with an invite code, press STOP, see leaderboards for events they joined and their own history. | Sign up on the **Create an account** page, or ask an admin. |
| **Host** | Everything a shooter can do, plus: create events, start and end them, clear a time, export results as CSV, delete their own events, see all their current and previous events. | An admin creates it, or changes an existing account's role. |
| **Admin** | Everything a host can do for **every** event, plus add and remove users, change roles, reset passwords and view stats. | The first admin is created when the app is installed. Admins can create more. |

Each role includes the one below it: **hosts and admins can also shoot**. They join any event with its invite code
or join link, like a shooter, and see their results under **My events** on the Events page. Joining someone else's event
doesn't give you its host controls. To shoot in an event you run, use **I'm shooting too** on the event page
(see [Shoot in an event you run](#shoot-in-an-event-you-run)).

Everyone can change their own password with **Change password** at the bottom of their home page.

## For shooters

### Create an account

On the sign-in page, tap **Create an account**. Enter:

- **Your name**: shown on leaderboards (up to 40 characters).
- **Username**: 3–30 letters, numbers, dots, dashes or underscores. Not case-sensitive.
- **Password**: at least 8 characters.

### Join an event

Use either of these:

- Open the **join link** the host shared. If you're not signed in, you'll be asked to sign in first and then
  joined automatically.
- Type the 6-character **invite code** under **Join an event** on your home page. Letters can be typed
  in either case.

You can only join **before** the host starts the event.

### During the event

1. **Waiting.** The screen says *"You're in. Waiting for the host to start…"*. Keep it open. You don't need
   to refresh.
2. **Running.** When the host starts, a clock and a big red **STOP** button appear.
3. **Stop.** Press **STOP once** when you've finished. Your time is recorded right away and **is final**.
4. You'll see your time and position (e.g. *#3 of 12*). The leaderboard updates as others finish.

Pressed STOP by accident? Ask the host to **Clear** your time. Your clock carries on from the original
shared start, so the time you lost waiting still counts.

If the host ends the event before you press STOP, you're listed as **Did not finish**.

### Your history

**My events** lists every event you've joined, with your time and rank or its current status. Tap one
to see its full leaderboard.

## For hosts

### Run an event

1. **Create.** On **Events**, type a name (e.g. *Saturday 10m air rifle*) and tap **Create event**.
2. **Invite.** The event page shows a big **invite code** and a **join link**. Use **Copy code** or **Copy link**
   to share them, or put the code on a screen. The **Joined** list fills in as shooters arrive.
3. **Start.** When everyone is in, tap **Start for everyone**, then **Tap again to start** to confirm.
   The button needs at least one joined shooter. After this:
   - the clock starts for every joined shooter at the same moment, and
   - **nobody else can join**.
4. **Watch.** The host screen shows the elapsed time, how many shooters have stopped, and the live
   leaderboard with each shooter's gap to the leader. **Still shooting** lists everyone who hasn't stopped.
5. **Fix mistakes.** If someone pressed STOP too early, tap **Clear** next to their name and then **Sure?**.
   They go back to *still shooting*, timed from the original start. You can only clear while the event is running.
6. **End.** Tap **End event**, then **Tap again to end**. Anyone who hasn't stopped is marked
   **Did not finish**. Ending can't be undone.

### Export results

Once an event has started, the leaderboard has an **Export CSV** button. It downloads a spreadsheet file
(e.g. `saturday-10m-air-rifle-2026-10-21.csv`) that opens in Excel, Numbers or Google Sheets, with these columns:

| Rank | Shooter | Time | Time (ms) | Gap | Status |
| --- | --- | --- | --- | --- | --- |
| 1 | Ann | 01:02.34 | 62345 | | Finished |
| 2 | Ben | 01:05.10 | 65102 | +00:02.75 | Finished |
| | Cal | | | | Did not finish |

Shooters who haven't stopped are listed at the end as *Still shooting* while the event is live, or
*Did not finish* once it has ended. Export after ending the event to get the final results.

### Manage events

- **Current events** shows events that are waiting or live. The invite code is shown for waiting events.
  **Previous events** shows finished ones.
- **Delete event** (two taps) removes the event and all its results for everyone. It's available before
  the start and after the end, but not while the event is live.
- Hosts see only their own events. Admins see every event.

### Shoot in other events

As a host you're also a shooter. Under **Shooting** on the Events page, enter another host's invite code in
**Join an event** (or open their join link), then use **STOP** like any shooter. Your results appear under **My events**
on the same page. You don't get the other host's controls or invite code.

### Shoot in an event you run

You can compete in an event you're running, on the same phone or tablet you run it from. Admins can do this for any event.

1. Before starting, tap **I'm shooting too** on the event page. You appear in the **Joined** list, and a green note
   confirms you're in. Tap **Not shooting** to change your mind. You can switch until you start the event.
2. Tap **Start for everyone**. Your timer starts at the same moment as everyone else's.
3. While the event is running, the big **STOP** button sits at the top of your screen, with the host controls
   (shooters stopped, **End event**) below it. Press **STOP** when you finish. Your time counts like anyone else's.
4. If you pressed STOP by mistake, you can **Clear** your own time in the leaderboard, as for any shooter.

Your result appears on the leaderboard, in the CSV export, and in the admins' stats. If you're the only one who joined,
you can still start the event, for example to practise.

### Tips for a smooth start

- Ask shooters to sign in and join **before** they go to their lanes. Joining is the slowest step.
- Check that the **Joined** count matches the number of shooters before you start.
- Ask everyone to keep the event screen open and their phone awake.

## For admins

Admins also have the **Users** and **Stats** pages.

### Users

- **Add a user.** Enter name, username, a temporary password (8+ characters) and role (**Host**, **Admin** or
  **Shooter**). Give them the password and ask them to change it with **Change password**.
- **Remove a user** (two taps). Be careful:
  - Removing a **shooter** deletes their results from **every** event's leaderboard.
  - Removing a **host** keeps their events. Only admins can manage those events afterwards.
  - You can't remove your own account.
- **Change a role** with the drop-down in the **Role** column (**Shooter**, **Host** or **Admin**). It saves straight
  away and applies on that user's next page load, with no need to sign in again. Nothing is deleted, so switching back
  restores everything:
  - A **shooter made host or admin** keeps their results and history, and can still join events as a shooter.
    They now also get the Events page and its host features.
  - A **host made shooter** can no longer create or manage events. Their events stay, still showing them as host,
    and admins can still run, end or delete them. If they had a live event, an admin will need to end it.
  - A **new admin** gets the Users and Stats pages and every event.
  - You can't change your own role. There is therefore always at least one admin. To step down, have another
    admin change your role.
- **Reset a password** for someone who forgot theirs. Open **Reset a password**, choose the user, enter a
  new temporary password (8+ characters) and tap **Reset password**. They're signed out on every device.
  Give them the new password and ask them to change it with **Change password**. Their results are kept.
  You can't reset your own password here: use **Change password**. If the only admin has forgotten their
  password, whoever runs the server can reset it (see the
  [deployment guide](deployment.md#operations-and-troubleshooting)).

### Stats

The **Stats** page gives an overview of the whole range:

- **Totals:** users by role, events by status, entries and times recorded, and the **finish rate**
  (the share of entries in finished events that weren't *did not finish*).
- **Shooters:** for each shooter, and each host who has shot in their own events (marked with their role), the events joined, times recorded, DNFs, **wins** (1st place) and
  **podiums** (top 3), and the date of their last event. Wins and podiums count only finished events,
  because ranks can still change while an event is live.
- **Hosts and admins:** the events each one created, how many of them are finished, total shooter
  entries in them, and the date of their last event.

## How timing works

- **The server keeps the time.** Start and stop times are recorded by the Pellet Pace machine, not by your
  phone. A phone with the wrong clock can't change results.
- A shooter's time is **STOP moment − shared start**, shown as `mm:ss.cc` (minutes, seconds, hundredths).
- The stop moment is when the server **receives** the STOP press. On a busy or weak Wi-Fi this
  can add a fraction of a second, so good Wi-Fi coverage on the line matters.
- Screens check for updates about every 1.5 seconds. After the host taps start, a shooter's clock can
  appear up to about a second later, but it already counts from the true start.
- **Ties** (identical times to the millisecond) share a rank.

## FAQ

**Do I need to install an app?** No. It runs in the browser.

**Can I join after the start?** No. Ask the host to run another event.

**I closed the page during the event.** Sign in again and open the event from **My events**. The clock
is still running and you can still press STOP.

**Why does my browser warn about the site?** The range uses a self-signed certificate. The connection
is still encrypted. See [Getting connected](#getting-connected).

**I was signed out.** Sign-ins last 14 days.
