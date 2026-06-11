"use client";

import { BookOpen, Film } from "lucide-react";
import { FootageLibrary } from "@/components/storyvault/footage-library";
import { StoryLibrary } from "@/components/storyvault/story-library";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export default function LibraryPage() {
  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Library</h1>
        <p className="text-muted-foreground">
          Your curated stories and background footage — switch between them with the tabs below.
        </p>
      </div>

      <Tabs defaultValue="stories">
        <TabsList>
          <TabsTrigger value="stories"><BookOpen className="mr-1 h-4 w-4" /> Stories</TabsTrigger>
          <TabsTrigger value="footage"><Film className="mr-1 h-4 w-4" /> Footage</TabsTrigger>
        </TabsList>
        <TabsContent value="stories" className="pt-4"><StoryLibrary /></TabsContent>
        <TabsContent value="footage" className="pt-4"><FootageLibrary /></TabsContent>
      </Tabs>
    </div>
  );
}
