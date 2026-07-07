"""Seed demo Whop data through the live API so the UI shows real content."""
import io
import json
import urllib.request
import urllib.error

BASE = "http://127.0.0.1:8000/api/v1"


def req(method, path, token=None, body=None, form=None):
    url = BASE + path
    headers = {}
    data = None
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    if form is not None:
        # multipart/form-data with a single file field
        boundary = "----seedboundary1234"
        parts = []
        fname, fbytes, ctype = form
        parts.append(f"--{boundary}".encode())
        parts.append(
            f'Content-Disposition: form-data; name="file"; filename="{fname}"'.encode()
        )
        parts.append(f"Content-Type: {ctype}".encode())
        parts.append(b"")
        parts.append(fbytes)
        parts.append(f"--{boundary}--".encode())
        data = b"\r\n".join(parts)
        headers["Content-Type"] = f"multipart/form-data; boundary={boundary}"
    r = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(r) as resp:
            raw = resp.read()
            return resp.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def login():
    # OAuth2 form login for the seeded superuser.
    data = urllib.parse.urlencode(
        {"username": "admin@openclip.local", "password": "changeme"}
    ).encode()
    r = urllib.request.Request(
        BASE + "/auth/token",
        data=data,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    with urllib.request.urlopen(r) as resp:
        return json.loads(resp.read())["access_token"]


import urllib.parse

# A tiny valid 1x1 PNG (orange) for thumbnails.
PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4"
    "89000000active"[:0].hex() if False else
    "89504e470d0a1a0a0000000d49484452000000010000000108020000009077"
    "53de0000000c49444154789c63f8cf8000000000ffff03000006000557bfab"
    "d40000000049454e44ae426082"
)


def main():
    token = login()
    print("logged in")

    campaigns = [
        {
            "name": "Rob the Bank Podcast Clips",
            "description": "Clip the most viral moments from the Rob the Bank podcast. $10/10,000 views.",
            "campaign_type": "clipping",
            "category": "personal_brand",
            "rate_per_1k": 3.0,
            "budget": 20000,
            "min_payout": 20,
            "max_payout": 500,
            "platforms": ["tiktok", "instagram", "youtube"],
            "requirements": [
                "Clips must be 10 seconds or longer",
                "Tag @robthebank on every post",
                "Must use #RobTheBank in the caption",
                "Dedicated clipping page only — no personal accounts",
                "Views must be real — no bots or paid promotion",
            ],
            "whop_url": "https://whop.com/rob-the-bank-clips/",
        },
        {
            "name": "Lovable UGC Creators",
            "description": "UGC content showing off lovable.dev. Build something lovable.",
            "campaign_type": "ugc",
            "category": "products",
            "rate_per_1k": 5.0,
            "budget": 10000,
            "min_payout": 25,
            "max_payout": 600,
            "platforms": ["tiktok", "instagram"],
            "requirements": [
                "On-screen demo of the product",
                "Face required (no faceless UGC)",
                "USA / UK / CA / AUS audience 70%+",
            ],
            "whop_url": "https://whop.com/lovable-creators/",
        },
        {
            "name": "Kalshi Bet Slip Clips",
            "description": "Post your Kalshi bet slip and earn per view.",
            "campaign_type": "clipping",
            "category": "products",
            "rate_per_1k": 0.5,
            "budget": None,
            "min_payout": 10,
            "max_payout": None,
            "platforms": ["tiktok", "x"],
            "requirements": ["Show a real Kalshi bet slip", "Affiliate link in bio"],
        },
    ]

    created = []
    for c in campaigns:
        status, camp = req("POST", "/whop/campaigns", token, c)
        assert status == 201, (status, camp)
        req("POST", f"/whop/campaigns/{camp['id']}/thumbnail", token,
            form=("thumb.png", PNG, "image/png"))
        created.append(camp)
        print(f"campaign #{camp['id']}: {camp['name']}")

    # Submissions across the first two campaigns, with a mix of statuses.
    subs = [
        (0, {"platform": "tiktok", "post_url": "https://www.tiktok.com/@clipper/video/1", "title": "Rob EXPOSES the truth about money", "creator_handle": "@viralclips", "views": 128000, "likes": 9400}, "pay"),
        (0, {"platform": "instagram", "post_url": "https://www.instagram.com/reel/abc2", "title": "This clip went insanely viral", "creator_handle": "@dailyrob", "views": 54000, "likes": 3100}, "approve"),
        (0, {"platform": "youtube", "post_url": "https://youtube.com/shorts/xyz3", "title": "Rob's best advice ever", "creator_handle": "@shortsking", "views": 22000, "likes": 1800}, "pending"),
        (0, {"platform": "tiktok", "post_url": "https://www.tiktok.com/@spam/video/4", "title": "low effort repost", "creator_handle": "@lowquality", "views": 3000, "likes": 40}, "reject"),
        (1, {"platform": "tiktok", "post_url": "https://www.tiktok.com/@builder/video/5", "title": "I built an app in 5 minutes with Lovable", "creator_handle": "@buildinpublic", "views": 210000, "likes": 15200}, "pay"),
        (1, {"platform": "instagram", "post_url": "https://www.instagram.com/reel/def6", "title": "Lovable review — is it worth it?", "creator_handle": "@techreviews", "views": 41000, "likes": 2600}, "approve"),
        (1, {"platform": "instagram", "post_url": "https://www.instagram.com/reel/ghi7", "title": "Vibe coding my startup", "creator_handle": "@founderlife", "views": 8700, "likes": 610}, "pending"),
    ]
    for idx, data, action in subs:
        cid = created[idx]["id"]
        status, sub = req("POST", f"/whop/campaigns/{cid}/submissions", token, data)
        assert status == 201, (status, sub)
        sid = sub["id"]
        if action == "approve":
            req("POST", f"/whop/submissions/{sid}/approve", token)
        elif action == "pay":
            req("POST", f"/whop/submissions/{sid}/approve", token)
            req("POST", f"/whop/submissions/{sid}/pay", token)
        elif action == "reject":
            req("POST", f"/whop/submissions/{sid}/reject", token,
                {"reason": "Does not meet the 10-second minimum and is a low-effort repost."})
        print(f"  submission #{sid} ({action}) views={data['views']}")

    # Build a little view history so the analytics chart has a curve:
    # bump the views on a couple of submissions a few times (each write snapshots).
    status, all_subs = req("GET", "/whop/submissions?limit=500", token)
    top = sorted(all_subs, key=lambda s: -s["views"])[:3]
    for s in top:
        base = s["views"]
        for mult in (1.15, 1.35, 1.6):
            req("PATCH", f"/whop/submissions/{s['id']}", token,
                {"views": int(base * mult)})
    print("seeded view history for chart")

    status, dash = req("GET", "/whop/dashboard", token)
    print("dashboard:", json.dumps({k: dash[k] for k in (
        "campaigns_active", "submissions_pending", "views_total",
        "paid_out", "pending_payout", "approval_rate")}, indent=2))


if __name__ == "__main__":
    main()
