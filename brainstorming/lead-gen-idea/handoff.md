Two files
leads_form.html — For VAs only. They open this to log leads.
leads_dashboard.html — For you (the manager). Full analytics view.
Both files work locally in any browser. They share data through the browser's localStorage — so both files must be open in the same browser on the same computer to sync in real time.

How the form works
VAs open the file, pick their name, choose Instagram or Meta Business, fill in the fields and submit. Username auto-detects from the profile link. Date is automatic.
Keywords — If a VA types Follower, Application, or Story Poll in the post link field, the lead is counted everywhere except the IG Posts ranking.

How the dashboard works
IG Posts tab — Ranking of posts/reels with most leads. Filterable by time period, date range, and team.
VAs tab — Cards per VA showing total leads, Instagram vs Meta split, team, and leads/hour efficiency. Click any VA to see their full lead detail.
All leads tab — Full list filterable by VA, source, and team.
Report tab — Summary with team breakdown, VA performance, and top posts. Download button generates a standalone HTML report file.

Admin panel (form only)
Tap the ⚙️ gear icon bottom-right → enter PIN 1995
From there you can:

Add or remove VAs
Assign a team to each VA
Set scheduled hours per day (Mon–Sun) for leads/hour calculation

Changes reflect instantly in the dashboard.

PIN
1995

Languages
Both files default to English. Toggle to Spanish with the language button top-right. Preference is saved per browser.

Important notes

Data is stored locally in the browser — if you clear browser data or use a different browser/computer, the data won't be there
To back up data: open browser console → localStorage.getItem('ig_leads') → copy and save that JSON
The files don't require internet after the initial load (except for icons from the CDN)
