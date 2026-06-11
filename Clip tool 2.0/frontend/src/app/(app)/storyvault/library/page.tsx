"use client";

import { BookOpen, Clapperboard, ClipboardPaste, Compass, Loader2, Trash2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  useSvDeleteStory,
  useSvDiscoverySearch,
  useSvImportStory,
  useSvMeta,
  useSvStories,
  useSvUpdateStory,
} from "@/hooks/use-api";
import type { SvStory, SvStoryStatus } from "@/lib/types";
import { formatRelativeTime } from "@/lib/utils";

const STATUS_OPTIONS: SvStoryStatus[] = ["new", "saved", "approved", "used", "excluded"];

function scoreVariant(score: number): "default" | "secondary" | "outline" {
  if (score >= 70) return "default";
  if (score >= 50) return "secondary";
  return "outline";
}

function StoryCard({ story }: { story: SvStory }) {
  const updateStory = useSvUpdateStory();
  const deleteStory = useSvDeleteStory();
  const [expanded, setExpanded] = useState(false);

  const setStatus = async (status: SvStoryStatus) => {
    try {
      await updateStory.mutateAsync({ id: story.id, data: { status } });
      toast.success(`Story marked as ${status}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update story");
    }
  };

  const onDelete = async () => {
    if (!confirm(`Delete "${story.title}"? This cannot be undone.`)) return;
    try {
      await deleteStory.mutateAsync(story.id);
      toast.success("Story deleted");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete story");
    }
  };

  return (
    <Card>
      <CardContent className="space-y-3 pt-6">
        <div className="flex items-start justify-between gap-3">
          <p className="font-medium">{story.title}</p>
          <div className="flex shrink-0 items-center gap-2">
            <Badge variant={scoreVariant(story.score)}>{Math.round(story.score)}</Badge>
            <Badge variant="outline">{story.status}</Badge>
          </div>
        </div>
        <p className="text-sm text-muted-foreground">
          {story.community ?? "manual"} · {story.upvotes} upvotes · {story.num_comments} comments ·{" "}
          {formatRelativeTime(story.created_at)}
        </p>
        <p
          className={`whitespace-pre-line text-sm text-muted-foreground ${expanded ? "" : "line-clamp-3"}`}
        >
          {story.body}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => setExpanded((v) => !v)}>
            <BookOpen className="h-4 w-4" /> {expanded ? "Collapse" : "Read"}
          </Button>
          {story.status !== "saved" && (
            <Button variant="outline" size="sm" disabled={updateStory.isPending} onClick={() => setStatus("saved")}>
              Save
            </Button>
          )}
          {story.status !== "approved" && (
            <Button variant="outline" size="sm" disabled={updateStory.isPending} onClick={() => setStatus("approved")}>
              Approve
            </Button>
          )}
          {story.status !== "excluded" && (
            <Button variant="outline" size="sm" disabled={updateStory.isPending} onClick={() => setStatus("excluded")}>
              Exclude
            </Button>
          )}
          <Button size="sm" asChild>
            <Link href={`/storyvault/studio?story=${story.id}`}>
              <Clapperboard className="h-4 w-4" /> Create video
            </Link>
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="ml-auto text-destructive hover:text-destructive"
            disabled={deleteStory.isPending}
            onClick={onDelete}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export default function StoryLibraryPage() {
  const [statusFilter, setStatusFilter] = useState("all");
  const [sort, setSort] = useState("score");
  const [search, setSearch] = useState("");

  const { data: stories = [], isLoading } = useSvStories({
    status: statusFilter === "all" ? undefined : statusFilter,
    q: search || undefined,
    sort,
  });
  const { data: meta } = useSvMeta();
  const discovery = useSvDiscoverySearch();
  const importStory = useSvImportStory();

  // Find stories dialog state
  const [findOpen, setFindOpen] = useState(false);
  const [communities, setCommunities] = useState("AmItheAsshole, relationship_advice, pettyrevenge");
  const [discoverSort, setDiscoverSort] = useState("top");
  const [timeWindow, setTimeWindow] = useState("week");
  const [minUpvotes, setMinUpvotes] = useState("100");

  // Paste story dialog state
  const [pasteOpen, setPasteOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [category, setCategory] = useState("");
  const [body, setBody] = useState("");

  const onDiscover = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const result = await discovery.mutateAsync({
        communities: communities.split(",").map((s) => s.trim()).filter(Boolean),
        sort: discoverSort,
        time_window: timeWindow,
        min_upvotes: Number(minUpvotes) || 0,
      });
      toast.success(`Added ${result.added} new stories (${result.duplicates} duplicates skipped)`);
      setFindOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to fetch stories");
    }
  };

  const onImport = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await importStory.mutateAsync({
        title,
        body,
        category: category || undefined,
        source_url: sourceUrl || undefined,
      });
      toast.success("Story imported");
      setPasteOpen(false);
      setTitle("");
      setSourceUrl("");
      setCategory("");
      setBody("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to import story");
    }
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Story Library</h1>
          <p className="text-muted-foreground">
            Discover stories from Reddit, curate them, and send the best to the studio.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Dialog open={findOpen} onOpenChange={setFindOpen}>
            <DialogTrigger asChild>
              <Button>
                <Compass className="h-4 w-4" /> Find stories
              </Button>
            </DialogTrigger>
            <DialogContent>
              <form onSubmit={onDiscover}>
                <DialogHeader>
                  <DialogTitle>Find stories</DialogTitle>
                  <DialogDescription>Pull top posts from Reddit communities.</DialogDescription>
                </DialogHeader>
                <div className="space-y-4 py-4">
                  <div className="space-y-2">
                    <Label htmlFor="communities">Subreddits (comma-separated)</Label>
                    <Input
                      id="communities"
                      value={communities}
                      onChange={(e) => setCommunities(e.target.value)}
                      placeholder="AmItheAsshole, relationship_advice"
                      required
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label>Sort</Label>
                      <Select value={discoverSort} onValueChange={setDiscoverSort}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {["top", "hot", "new", "rising"].map((s) => (
                            <SelectItem key={s} value={s}>
                              {s}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label>Time window</Label>
                      <Select value={timeWindow} onValueChange={setTimeWindow}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {["day", "week", "month", "year", "all"].map((t) => (
                            <SelectItem key={t} value={t}>
                              {t}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="min-upvotes">Minimum upvotes</Label>
                    <Input
                      id="min-upvotes"
                      type="number"
                      min={0}
                      value={minUpvotes}
                      onChange={(e) => setMinUpvotes(e.target.value)}
                    />
                  </div>
                </div>
                <DialogFooter>
                  <Button type="submit" disabled={discovery.isPending}>
                    {discovery.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                    Search
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
          <Dialog open={pasteOpen} onOpenChange={setPasteOpen}>
            <DialogTrigger asChild>
              <Button variant="outline">
                <ClipboardPaste className="h-4 w-4" /> Paste story
              </Button>
            </DialogTrigger>
            <DialogContent>
              <form onSubmit={onImport}>
                <DialogHeader>
                  <DialogTitle>Paste a story</DialogTitle>
                  <DialogDescription>Manually import a story from anywhere.</DialogDescription>
                </DialogHeader>
                <div className="space-y-4 py-4">
                  <div className="space-y-2">
                    <Label htmlFor="story-title">Title</Label>
                    <Input
                      id="story-title"
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                      placeholder="AITA for ..."
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="story-url">Source URL (optional)</Label>
                    <Input
                      id="story-url"
                      value={sourceUrl}
                      onChange={(e) => setSourceUrl(e.target.value)}
                      placeholder="https://..."
                    />
                  </div>
                  {meta && meta.categories.length > 0 && (
                    <div className="space-y-2">
                      <Label>Category (optional)</Label>
                      <Select value={category} onValueChange={setCategory}>
                        <SelectTrigger>
                          <SelectValue placeholder="Pick a category" />
                        </SelectTrigger>
                        <SelectContent>
                          {meta.categories.map((c) => (
                            <SelectItem key={c} value={c}>
                              {c}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                  <div className="space-y-2">
                    <Label htmlFor="story-body">Story</Label>
                    <Textarea
                      id="story-body"
                      rows={8}
                      value={body}
                      onChange={(e) => setBody(e.target.value)}
                      placeholder="Paste the full story text here..."
                      required
                    />
                  </div>
                </div>
                <DialogFooter>
                  <Button type="submit" disabled={importStory.isPending}>
                    {importStory.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                    Import
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search stories..."
          className="max-w-xs"
        />
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-[150px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {STATUS_OPTIONS.map((s) => (
              <SelectItem key={s} value={s}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={sort} onValueChange={setSort}>
          <SelectTrigger className="w-[150px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="score">Best score</SelectItem>
            <SelectItem value="newest">Newest</SelectItem>
            <SelectItem value="upvotes">Most upvotes</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : stories.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
            <Compass className="h-10 w-10 text-muted-foreground" />
            <p className="text-muted-foreground">No stories yet — pull some in with Find stories.</p>
            <Button onClick={() => setFindOpen(true)}>
              <Compass className="h-4 w-4" /> Find stories
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {stories.map((s) => (
            <StoryCard key={s.id} story={s} />
          ))}
        </div>
      )}
    </div>
  );
}
