// Sends a Web Push notification for one activity event (comment/like/save on
// a pin you own, or a follow request sent to you) — the same events that
// show up in the in-app notifications panel. Invoked by a Postgres trigger
// (see migration_push_notifications.sql) via pg_net's net.http_post on
// INSERT to pin_comments/pin_likes/pin_saves/friend_requests. Never called
// directly by the client.
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PUSH_TRIGGER_SECRET = Deno.env.get("PUSH_TRIGGER_SECRET")!;

webpush.setVapidDetails(
  Deno.env.get("VAPID_SUBJECT")!,
  Deno.env.get("VAPID_PUBLIC_KEY")!,
  Deno.env.get("VAPID_PRIVATE_KEY")!,
);

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

type Kind = "comment" | "like" | "save" | "follow_request";
type Payload = {
  kind: Kind;
  actorId: string;
  recipientId: string;
  pinId?: string;
  pinTitle?: string;
  commentBody?: string;
};

Deno.serve(async (req) => {
  if (req.headers.get("x-push-secret") !== PUSH_TRIGGER_SECRET) {
    return new Response("unauthorized", { status: 401 });
  }

  const { kind, actorId, recipientId, pinId, pinTitle, commentBody }: Payload = await req.json();
  if (recipientId === actorId) return new Response("self-action, skipped", { status: 200 });

  const { data: actor } = await supabase.from("profiles").select("username").eq("id", actorId).single();
  const actorName = actor?.username || "Someone";

  const titles: Record<Kind, string> = {
    comment: `${actorName} commented on "${pinTitle}"`,
    like: `${actorName} liked "${pinTitle}"`,
    save: `${actorName} saved "${pinTitle}"`,
    follow_request: `${actorName} sent you a follow request`,
  };

  const { data: subs } = await supabase
    .from("push_subscriptions")
    .select("id, endpoint, p256dh, auth")
    .eq("user_id", recipientId);
  if (!subs?.length) return new Response("no subscriptions", { status: 200 });

  const payload = JSON.stringify({
    title: titles[kind],
    body: kind === "comment" ? (commentBody?.slice(0, 120) || "") : "",
    url: kind === "follow_request" ? `/profile.html?id=${actorId}` : `/pins.html?openPinId=${pinId}`,
  });

  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload,
        );
      } catch (err) {
        // 404/410 means the browser unsubscribed or the subscription expired
        // — clean it up so we stop trying. Any other error, leave it alone.
        if (err?.statusCode === 404 || err?.statusCode === 410) {
          await supabase.from("push_subscriptions").delete().eq("id", sub.id);
        }
      }
    }),
  );

  return new Response("ok", { status: 200 });
});
