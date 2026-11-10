#!/bin/bash
cd /opt/erm/server
timeout 240 node --env-file=.env _tmp_certbind.mjs > /tmp/_certbind.out 2>&1
echo "exit $?"
grep -E '^(CERT|  )' /tmp/_certbind.out | cut -c1-1500
echo "--- tail"
tail -n 8 /tmp/_certbind.out | cut -c1-500
rm -f _tmp_certbind.mjs /tmp/_certbind.out
