# Contributing to Cairn

Thank you for helping. This file covers the legal side of a contribution: the
license, the Contributor License Agreement (CLA), work done for an employer,
AI-assisted work and third-party code. [AGENTS.md](AGENTS.md) covers how work
is built and checked: `pnpm check`, the git hooks, stacked branches and
commit trailers.

## How Cairn is licensed

Cairn is licensed under `AGPL-3.0-only` ([LICENSE](LICENSE)); the
[README](README.md#license) explains what that means for people who use it.
Contributions are accepted under the same license and the
[CLA](CLA.md). Third-party code keeps its own license
([THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)).

## The Contributor License Agreement

> **Status: draft, not yet in effect.** The CLA is pending legal review, and
> the CLA check is not running on pull requests. Until it is, the maintainer
> will not merge external contributions; open an issue first if you want to
> discuss one.

**Why there is a CLA.** You keep the copyright in what you contribute. The CLA
gives the maintainer a broad license to it, including the right to offer
Cairn under other licenses (for example a commercial license next to the
AGPL) and to change its licensing later. Without it, every contributor would
have to be asked again before Cairn's licensing could change. The CLA also
promises that each contribution stays available under the license Cairn used
when you made it.

**Who signs.** Anyone whose work appears in a pull request: the author of
each commit, and each human named in a `Co-authored-by` trailer. People who
only use Cairn never sign.

**How to sign.** Open your pull request as usual. A bot, CLA Assistant,
comments with a link if any author has not signed the current version. Follow
the link, sign in with GitHub, fill in your name and email and accept. The
check on the pull request turns green and stays green on your later pull
requests until the agreement's version changes. There is nothing to copy into
the pull request.

## Contributing on behalf of an employer

If your employer or client owns what you write at work, your employer has to
accept the agreement before your contribution can be merged (CLA
[Part B](CLA.md#part-b-entity-contributions)).

1. Ask the maintainer for the entity agreement by opening an issue titled
   "Entity CLA: <organisation>" (do not post signatures or contracts in it).
2. A person authorised to bind the organisation signs it, naming a CLA
   Manager and the GitHub accounts allowed to contribute, and sends it to the
   maintainer privately.
3. Each of those people also signs through the bot, choosing "on behalf of an
   entity".
4. The CLA Manager tells the maintainer when the list of accounts changes.

If you are not sure whether your employer has rights in your work, ask them
before you contribute.

## AI-assisted contributions

Cairn is built with coding agents, and contributions made with them are
welcome.

- You are the contributor. You sign the CLA and you answer for everything in
  your pull request, whichever tool wrote it. An AI tool or agent cannot sign
  and is not a party.
- Review what the tool produced before you submit it.
- Make sure the tool's terms let you contribute its output, and that you have
  no reason to think the output copies someone else's code.
- Say which tool helped, with a `Co-authored-by:` or `Assisted-by:` trailer
  naming the tool, or a line in the pull request. A tool named in a trailer
  does not sign; the human author's signature covers the commit.
- An agent that opens pull requests or pushes commits does so under a human's
  or an organisation's GitHub account, and that account's owner signs. Commits
  authored by an account that cannot sign, such as an agent's bot account,
  have to be re-authored under the responsible person's account.

## Third-party code

- Do not paste code, text, images or fonts you did not write unless their
  license allows it and is compatible with `AGPL-3.0-only`. MIT, BSD, ISC,
  Apache-2.0 and similar permissive licenses are; "no license", proprietary
  terms and licenses with field-of-use restrictions are not.
- Submit third-party material in its own commit, say where it came from and
  under which license, and keep its copyright and license notices. Add it to
  [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
- A new npm dependency needs a license compatible with `AGPL-3.0-only`.

## If the CLA check fails

| What the bot says                                    | What to do                                                                                                                                                                                                                    |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| You have not signed                                  | Follow its link and sign.                                                                                                                                                                                                     |
| A commit author "seems not to be a GitHub user"      | The commit's author email is not on any GitHub account. Add the email to your account (Settings, Emails), or re-author the commits (`git rebase --exec 'git commit --amend --no-edit --reset-author' <base>`) and push again. |
| Someone else in the pull request has not signed      | Each commit author signs. Ask them to, or re-author their commits only if you wrote them.                                                                                                                                     |
| You signed, but it still asks                        | The agreement may have a new version; sign it again. Otherwise use the bot's "recheck" link, or check that you signed with the account that authored the commits.                                                             |
| You are contributing for an employer                 | See [Contributing on behalf of an employer](#contributing-on-behalf-of-an-employer).                                                                                                                                          |
| The maintainer asks about a `Co-authored-by` trailer | CLA Assistant checks commit authors, not trailers, so the maintainer checks them by hand. Each human co-author signs; an AI tool named in a trailer does not.                                                                 |

If none of these fits, comment on the pull request and the maintainer will
look.
