#!/usr/bin/env python3
"""Wipe the synthetic test users' data from the isolated `test` Firestore database.

Run by the orchestrator after every spec-verifier pass (see /implement-spec and /fix-bug), so each
verification starts from clean data. It only ever touches database `test` and only user ids that
start with 9000000 (the synthetic verifier users); the owner's data and the production
`(default)` database are never read or written.

Usage:  T=$(gcloud auth print-access-token) python3 -I scripts/cleanup-test-db.py list|delete
"""
import json, os, sys, urllib.request
TOKEN = os.environ["T"]; PROJ = "notes-506213"
DB = "test"  # never change this: production is "(default)"
BASE = f"https://firestore.googleapis.com/v1/projects/{PROJ}/databases/{DB}/documents"
def call(method, url, body=None):
    req = urllib.request.Request(url, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req) as r:
        t = r.read(); return json.loads(t) if t else {}
def collection_ids(parent):
    out, tok = [], None
    while True:
        b = {"pageSize": 300}; 
        if tok: b["pageToken"] = tok
        r = call("POST", f"{parent}:listCollectionIds", b)
        out += r.get("collectionIds", []); tok = r.get("nextPageToken")
        if not tok: return out
def docs(parent, coll):
    out, tok = [], None
    while True:
        u = f"{parent}/{coll}?pageSize=300&showMissing=true&mask.fieldPaths=__name__" + (f"&pageToken={tok}" if tok else "")
        r = call("GET", u); out += [d["name"] for d in r.get("documents", [])]; tok = r.get("nextPageToken")
        if not tok: return out
def walk(docname):
    """All document names under docname (depth first), docname last."""
    names = []
    url = f"https://firestore.googleapis.com/v1/{docname}"
    for c in collection_ids(url):
        for d in docs(url, c): names += walk(d)
    return names + [docname]
mode = sys.argv[1]
print("top-level:", collection_ids(BASE.rsplit('/documents',1)[0] + "/documents"))
users = docs(BASE, "users")
ids = [u.rsplit("/",1)[1] for u in users]
print("users:", ids)
targets = [u for u in users if u.rsplit("/",1)[1].startswith("9000000")]
allnames = []
for u in targets:
    n = walk(u); allnames += n
    print(u.rsplit('/',1)[1], "docs:", len(n))
if mode == "delete":
    for i in range(0, len(allnames), 400):
        chunk = allnames[i:i+400]
        call("POST", f"https://firestore.googleapis.com/v1/projects/{PROJ}/databases/{DB}/documents:batchWrite",
             {"writes": [{"delete": n} for n in chunk]})
    print("deleted", len(allnames))
