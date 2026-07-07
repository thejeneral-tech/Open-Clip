"""End-to-end smoke test of the real clip pipeline through the Studio link."""
import io, json, time, urllib.request, urllib.parse, urllib.error, mimetypes, os

BASE = "http://127.0.0.1:8000/api/v1"


def login():
    data = urllib.parse.urlencode({"username": "admin@openclip.local", "password": "changeme"}).encode()
    r = urllib.request.Request(BASE + "/auth/token", data=data,
                               headers={"Content-Type": "application/x-www-form-urlencoded"}, method="POST")
    return json.loads(urllib.request.urlopen(r).read())["access_token"]


def req(method, path, token, body=None):
    headers = {"Authorization": f"Bearer {token}"}
    data = None
    if body is not None:
        data = json.dumps(body).encode(); headers["Content-Type"] = "application/json"
    r = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(r, timeout=60) as resp:
            raw = resp.read(); return resp.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def upload(path, token, project_id):
    fn = os.path.basename(path)
    with open(path, "rb") as f:
        fbytes = f.read()
    boundary = "----pipetest99"
    parts = [f"--{boundary}".encode(),
             f'Content-Disposition: form-data; name="file"; filename="{fn}"'.encode(),
             b"Content-Type: video/mp4", b"", fbytes,
             f"--{boundary}".encode(),
             b'Content-Disposition: form-data; name="title"', b"", b"Studio pipeline test",
             f"--{boundary}--".encode()]
    data = b"\r\n".join(parts)
    r = urllib.request.Request(f"{BASE}/projects/{project_id}/videos/upload", data=data,
                               headers={"Authorization": f"Bearer {token}",
                                        "Content-Type": f"multipart/form-data; boundary={boundary}"}, method="POST")
    with urllib.request.urlopen(r, timeout=120) as resp:
        return json.loads(resp.read())


def main():
    token = login(); print("logged in")
    st, studio = req("POST", "/whop/campaigns/1/studio", token)
    pid = studio["project_id"]; print("studio project_id:", pid)

    video = upload(r".claude/studio-test-source.mp4", token, pid)
    vid = video["id"]; print("uploaded video id:", vid, "status:", video["status"])

    # Wait for ingest/probe to finish (status -> completed, duration set).
    for _ in range(40):
        st, v = req("GET", f"/videos/{vid}", token)
        if v["status"] in ("completed", "failed") and (v.get("duration_seconds") or 0) > 0:
            break
        if v["status"] == "failed":
            print("ingest failed:", v.get("error")); return
        time.sleep(2)
    print("ingest done. status:", v["status"], "duration:", v.get("duration_seconds"))

    # Process: 3 clips, vertical, captions on, explicit installed model, reframe off for speed.
    st, task = req("POST", f"/videos/{vid}/process", token, {
        "target_clip_count": 3, "min_clip_seconds": 8, "max_clip_seconds": 40,
        "aspect_ratios": ["9:16"], "enable_captions": True, "enable_reframe": False,
        "generate_broll": False, "model": "llama3.2:1b",
    })
    print("process queued:", st, task)

    # Poll until clips are done (or timeout).
    deadline = time.time() + 1500  # 25 min ceiling
    last = None
    while time.time() < deadline:
        st, v = req("GET", f"/videos/{vid}", token)
        st, clips = req("GET", f"/videos/{vid}/clips?sort=score", token)
        clips = clips if isinstance(clips, list) else []
        done = [c for c in clips if c["status"] == "completed"]
        msg = f"video={v['status']}/{v.get('stage')} p={round((v.get('progress') or 0)*100)}% clips={len(clips)} done={len(done)}"
        if msg != last:
            print(time.strftime("%H:%M:%S"), msg); last = msg
        if v["status"] == "failed":
            print("VIDEO FAILED:", v.get("error")); break
        if clips and all(c["status"] in ("completed", "failed") for c in clips) and v["status"] == "completed":
            break
        time.sleep(5)

    st, clips = req("GET", f"/videos/{vid}/clips?sort=score", token)
    print("\n=== FINAL CLIPS ===")
    for c in (clips if isinstance(clips, list) else []):
        print(f"  score={round(c.get('ranking_score') or c.get('viral_score') or 0)} "
              f"status={c['status']} {round(c['start_time'])}-{round(c['end_time'])}s "
              f"preview={'yes' if c.get('preview_path') else 'no'} :: {c.get('title')}")
    print("video_id:", vid, "project_id:", pid)


if __name__ == "__main__":
    main()
