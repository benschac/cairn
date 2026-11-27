import { Array, Context, Effect, Layer, Ref, Schema } from "effect";

import { HostedEnv } from "./env.ts";

/** One email: a single recipient, a subject, and a plain-text body with an HTML copy. */
export const Mail = Schema.Struct({
  html: Schema.String,
  subject: Schema.NonEmptyString,
  text: Schema.String,
  to: Schema.NonEmptyString,
});
export type Mail = typeof Mail.Type;

/** The mail service refused or could not take a message. */
export class MailFailed extends Schema.TaggedError<MailFailed, { readonly brand: unique symbol }>()(
  "MailFailed",
  { message: Schema.String, cause: Schema.Defect() },
) {}

/**
 * Sends the service's email: sign-in links now, invitations later. The live layer sends through
 * Cloudflare Email Service, the `MAIL` binding, from the `mail.` subdomain of `CAIRN_DOMAIN`. If that
 * service cannot deliver to an address, a transactional email provider takes its place behind this
 * same service.
 */
export class Mailer extends Context.Service<
  Mailer,
  { readonly send: (mail: Mail) => Effect.Effect<void, MailFailed> }
>()("@cairn/hosted/Mailer") {
  static readonly live = Layer.effect(
    Mailer,
    Effect.gen(function* () {
      const env = yield* HostedEnv;
      const from = { email: `sign-in@mail.${env.CAIRN_DOMAIN}`, name: "Cairn" };
      return Mailer.of({
        send: (mail) =>
          Effect.tryPromise({
            try: () =>
              env.MAIL.send({
                from,
                html: mail.html,
                subject: mail.subject,
                text: mail.text,
                to: mail.to,
              }),
            catch: (cause) =>
              new MailFailed({ message: `Could not send mail to ${mail.to}.`, cause }),
          }).pipe(Effect.asVoid),
      });
    }),
  );

  /** Keeps each message in `outbox`, oldest first, instead of sending it. */
  static readonly test = (outbox: Ref.Ref<ReadonlyArray<Mail>>) =>
    Layer.succeed(Mailer, Mailer.of({ send: (mail) => Ref.update(outbox, Array.append(mail)) }));
}
