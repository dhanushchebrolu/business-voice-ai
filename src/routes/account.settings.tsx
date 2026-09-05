import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { z } from "zod";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { profileQuery } from "@/lib/profile";
import { LANGUAGES } from "@/lib/voices";
import { PageHeader, SectionCard } from "@/components/app/primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const searchSchema = z.object({
  tab: z.enum(["account", "security", "preferences", "notifications"]).optional(),
});

export const Route = createFileRoute("/account/settings")({
  validateSearch: searchSchema,
  head: () => ({
    meta: [
      { title: "Settings — Vaani" },
      { name: "description", content: "Account, security, preferences and notifications." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AccountSettings,
});

function AccountSettings() {
  const search = Route.useSearch();
  const { user } = useAuth();
  const qc = useQueryClient();
  const { data: profile, isLoading } = useQuery(profileQuery(user?.id));

  if (isLoading || !user) {
    return (
      <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Loading settings…
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings"
        description="Account details, security, preferences and notifications."
      />

      <Tabs defaultValue={search.tab ?? "account"}>
        <TabsList>
          <TabsTrigger value="account">Account</TabsTrigger>
          <TabsTrigger value="security">Security</TabsTrigger>
          <TabsTrigger value="preferences">Preferences</TabsTrigger>
          <TabsTrigger value="notifications">Notifications</TabsTrigger>
        </TabsList>

        <TabsContent value="account">
          <AccountTab
            userId={user.id}
            fullName={profile?.full_name ?? ""}
            phone={profile?.phone ?? ""}
            onSaved={() => qc.invalidateQueries({ queryKey: ["profile"] })}
          />
        </TabsContent>
        <TabsContent value="security">
          <SecurityTab />
        </TabsContent>
        <TabsContent value="preferences">
          <PreferencesTab
            userId={user.id}
            preferredLanguage={profile?.preferred_language ?? ""}
            timezone={profile?.timezone ?? "Asia/Kolkata"}
            onSaved={() => qc.invalidateQueries({ queryKey: ["profile"] })}
          />
        </TabsContent>
        <TabsContent value="notifications">
          <NotificationsTab
            userId={user.id}
            notifyEmail={profile?.notify_email ?? true}
            notifyCallSummaries={profile?.notify_call_summaries ?? true}
            onSaved={() => qc.invalidateQueries({ queryKey: ["profile"] })}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function AccountTab({
  userId,
  fullName: initialFullName,
  phone: initialPhone,
  onSaved,
}: {
  userId: string;
  fullName: string;
  phone: string;
  onSaved: () => void;
}) {
  const { user } = useAuth();
  const [fullName, setFullName] = useState(initialFullName);
  const [phone, setPhone] = useState(initialPhone);
  const [saving, setSaving] = useState(false);

  useEffect(() => setFullName(initialFullName), [initialFullName]);
  useEffect(() => setPhone(initialPhone), [initialPhone]);

  async function save() {
    setSaving(true);
    try {
      const { error } = await supabase
        .from("profiles")
        .update({ full_name: fullName.trim() || null, phone: phone.trim() || null })
        .eq("id", userId);
      if (error) throw error;
      toast.success("Profile updated.");
      onSaved();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save your profile.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <SectionCard
      title="Account"
      description="Your name, phone and account email."
      actions={
        <Button size="sm" onClick={save} disabled={saving}>
          {saving ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : null}Save
        </Button>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Full name</Label>
          <Input
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            placeholder="Your name"
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Phone</Label>
          <Input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+91 98765 43210"
          />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label className="text-xs text-muted-foreground">Email</Label>
          <Input value={user?.email ?? ""} disabled />
          <p className="text-xs text-muted-foreground">
            Your sign-in email is managed by your account provider and can't be changed here.
          </p>
        </div>
      </div>
    </SectionCard>
  );
}

function SecurityTab() {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const mismatch = confirmPassword.length > 0 && password !== confirmPassword;

  async function changePassword() {
    if (password.length < 8) {
      toast.error("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirmPassword) {
      toast.error("Passwords do not match.");
      return;
    }
    setSaving(true);
    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      toast.success("Password updated.");
      setPassword("");
      setConfirmPassword("");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not update your password.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <SectionCard title="Security" description="Change your password.">
      <div className="grid max-w-md gap-4">
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">New password</Label>
          <PasswordInput
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="At least 8 characters"
            autoComplete="new-password"
            fieldLabel="new password"
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Confirm new password</Label>
          <PasswordInput
            minLength={8}
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            placeholder="Re-enter your new password"
            autoComplete="new-password"
            fieldLabel="confirm new password"
          />
          {mismatch ? <p className="text-xs text-destructive">Passwords do not match.</p> : null}
        </div>
        <Button
          className="w-fit"
          onClick={changePassword}
          disabled={saving || !password || mismatch}
        >
          {saving ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : null}Update password
        </Button>
      </div>
    </SectionCard>
  );
}

function PreferencesTab({
  userId,
  preferredLanguage,
  timezone: initialTimezone,
  onSaved,
}: {
  userId: string;
  preferredLanguage: string;
  timezone: string;
  onSaved: () => void;
}) {
  const [language, setLanguage] = useState(preferredLanguage);
  const [timezone, setTimezone] = useState(initialTimezone);
  const [saving, setSaving] = useState(false);

  useEffect(() => setLanguage(preferredLanguage), [preferredLanguage]);
  useEffect(() => setTimezone(initialTimezone), [initialTimezone]);

  async function save() {
    setSaving(true);
    try {
      const { error } = await supabase
        .from("profiles")
        .update({
          preferred_language: language || null,
          timezone: timezone.trim() || "Asia/Kolkata",
        })
        .eq("id", userId);
      if (error) throw error;
      toast.success("Preferences updated.");
      onSaved();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save preferences.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <SectionCard
      title="Preferences"
      description="Your preferred language and timezone."
      actions={
        <Button size="sm" onClick={save} disabled={saving}>
          {saving ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : null}Save
        </Button>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Preferred language</Label>
          <Select {...(language ? { value: language } : {})} onValueChange={setLanguage}>
            <SelectTrigger>
              <SelectValue placeholder="No preference" />
            </SelectTrigger>
            <SelectContent>
              {LANGUAGES.map((l) => (
                <SelectItem key={l.code} value={l.code}>
                  {l.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Timezone</Label>
          <Input
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            placeholder="Asia/Kolkata"
          />
        </div>
      </div>
    </SectionCard>
  );
}

function NotificationsTab({
  userId,
  notifyEmail: initialNotifyEmail,
  notifyCallSummaries: initialNotifyCallSummaries,
  onSaved,
}: {
  userId: string;
  notifyEmail: boolean;
  notifyCallSummaries: boolean;
  onSaved: () => void;
}) {
  const [notifyEmail, setNotifyEmail] = useState(initialNotifyEmail);
  const [notifyCallSummaries, setNotifyCallSummaries] = useState(initialNotifyCallSummaries);
  const [saving, setSaving] = useState(false);

  useEffect(() => setNotifyEmail(initialNotifyEmail), [initialNotifyEmail]);
  useEffect(() => setNotifyCallSummaries(initialNotifyCallSummaries), [initialNotifyCallSummaries]);

  async function update(next: { notify_email?: boolean; notify_call_summaries?: boolean }) {
    setSaving(true);
    try {
      const { error } = await supabase.from("profiles").update(next).eq("id", userId);
      if (error) throw error;
      onSaved();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save notification settings.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <SectionCard title="Notifications" description="What Vaani emails you about.">
      <ul className="divide-y divide-border">
        <li className="flex items-center justify-between gap-3 py-3">
          <div>
            <p className="text-sm font-medium">General account emails</p>
            <p className="text-xs text-muted-foreground">Billing, security and account updates.</p>
          </div>
          <Switch
            checked={notifyEmail}
            disabled={saving}
            onCheckedChange={(v) => {
              setNotifyEmail(v);
              void update({ notify_email: v });
            }}
          />
        </li>
        <li className="flex items-center justify-between gap-3 py-3">
          <div>
            <p className="text-sm font-medium">Call summary emails</p>
            <p className="text-xs text-muted-foreground">
              A summary after your receptionist handles a call.
            </p>
          </div>
          <Switch
            checked={notifyCallSummaries}
            disabled={saving}
            onCheckedChange={(v) => {
              setNotifyCallSummaries(v);
              void update({ notify_call_summaries: v });
            }}
          />
        </li>
      </ul>
    </SectionCard>
  );
}
