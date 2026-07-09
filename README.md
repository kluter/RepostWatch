# RepostWatch

Job postings that keep getting reposted over and over are a pet peeve of mine. So I built this little tool that keeps me up to date on the companies that I find interesting. RepostWatch shows me how fresh each posting really is.

The way a company treats its job posts: 
- how often they recycle them, 
- how long roles sit open, 
- whether they quietly republish the same thing for months, 

says a lot about what's actually going on inside. RepostWatch is my window into that.

## How it works

Every day a GitHub Action runs [poll.py](poll.py), which pulls each company's public job feed and compares it against yesterday's snapshot. Anything that opened, closed, or got republished gets logged, and the new history is committed straight back to the repo. GitHub Pages then serves a static dashboard that reads all of that right in the browser.

No server, no database. Just the data and a page to look at it.

Every change lands in the history as one of a handful of events:

| event | what it means |
|---|---|
| `opened` | a new role showed up in the feed |
| `closed` | a role that was listed is gone |
| `republished` | the same role went back up, often under a fresh ID |
| `initialized` | the role was already listed when I started tracking |
| `headcount_manual` | a headcount number I entered by hand |
