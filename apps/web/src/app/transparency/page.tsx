'use client'
import { useEffect, useState } from 'react'
import { API_URL } from '@/lib/config'
import { REPO_URL, agentPrompt, type ReleaseInfo } from '@/lib/transparency'

// Keep in step with apps/docs/src/content/docs/security/transparency.md
const code = 'rounded bg-gray-800 px-1.5 py-0.5 text-sm'
const link = 'text-blue-400 hover:underline'

function Running({ info, error }: { info: ReleaseInfo | null; error: boolean }) {
  if (error) return <p className="text-amber-300" role="alert">The server didn’t answer just now. Try again, or ask it directly at <code className={code}>{API_URL}/api/transparency</code>.</p>
  if (!info) return <p className="text-gray-500" role="status">Loading what’s running…</p>
  if (!info.verified) {
    return (
      <p className="rounded-md border border-amber-700/60 bg-amber-900/20 p-3 text-amber-200" role="status">
        This server wasn’t built by our public CI, so it can’t be checked against the repo. Release: <code className={code}>{info.release}</code>.
      </p>
    )
  }
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
      <dt className="text-gray-500">Commit</dt>
      <dd className="min-w-0 break-all"><a href={info.commitUrl!} className={link}>{info.commit}</a></dd>
      <dt className="text-gray-500">Built by</dt>
      <dd><a href={info.buildUrl!} className={link}>GitHub Actions run</a></dd>
      <dt className="text-gray-500">Image</dt>
      <dd className="min-w-0 break-all"><code className={code}>{info.image}</code></dd>
      {info.manifest && (
        <>
          <dt className="text-gray-500">Website files</dt>
          <dd className="min-w-0 break-all"><a href={info.manifest.url} className={link}>release-manifest.json</a> <span className="text-gray-500">sha256 {info.manifest.sha256}</span></dd>
        </>
      )}
    </dl>
  )
}

export default function TransparencyPage() {
  const [info, setInfo] = useState<ReleaseInfo | null>(null)
  const [error, setError] = useState(false)
  const [web, setWeb] = useState('https://virvi.io')
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    setWeb(window.location.origin)
    fetch(`${API_URL}/api/transparency`).then((r) => (r.ok ? r.json() : Promise.reject())).then(setInfo, () => setError(true))
  }, [])

  const prompt = agentPrompt({ web, api: API_URL })
  const copy = () => {
    navigator.clipboard.writeText(prompt).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000) }, () => {})
  }

  return (
    <div className="min-h-screen bg-gray-950 px-4 py-12 sm:px-6">
      <article className="mx-auto max-w-2xl text-gray-300 [&_h2]:mb-3 [&_h2]:mt-10 [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:text-white [&_li]:mt-2 [&_p]:leading-relaxed">
        <a href="/" className="text-sm text-gray-400 hover:text-white">← Back to Virvi</a>
        <h1 className="mt-6 text-3xl font-semibold tracking-tight text-white">Transparency and safety</h1>
        <p className="mt-4">
          Virvi’s code is public at <a href={REPO_URL} className={link}>github.com/virvi-xr/virvi</a>. Every release is built from a public
          commit by GitHub Actions, which signs a record of exactly what it built. This page shows which commit is running, and how to check
          it yourself.
        </p>

        <h2>What’s running now</h2>
        <Running info={info} error={error} />

        <h2>Ask your AI agent to check</h2>
        <p>Paste this into an AI agent that can read GitHub and websites. It reviews the code for you and reports back in plain language.</p>
        <div className="relative mt-3">
          <pre className="whitespace-pre-wrap rounded-lg border border-gray-800 bg-gray-900 p-4 pr-20 text-sm text-gray-200">{prompt}</pre>
          <button type="button" onClick={copy} className="absolute right-3 top-3 rounded-md bg-gray-800 px-3 py-1 text-xs hover:bg-gray-700">
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>

        <h2>Check it yourself</h2>
        <p>With Git, Docker and the GitHub CLI installed, run this from a copy of the repo:</p>
        <pre className="mt-3 overflow-x-auto rounded-lg border border-gray-800 bg-gray-900 p-4 text-sm text-gray-200">bash scripts/verify-release.sh</pre>
        <p className="mt-3">It:</p>
        <ul className="list-disc pl-5">
          <li>asks the server which commit it runs;</li>
          <li>checks GitHub’s signed record that the image was built from that commit (<code className={code}>gh attestation verify</code>);</li>
          <li>rebuilds the website from that commit, and compares every file’s SHA-256 with what this site serves.</li>
        </ul>
        <p className="mt-3">It prints PASS, or exactly which files differ.</p>

        <h2>What this proves, and what it can’t</h2>
        <ul className="list-disc pl-5">
          <li><strong>The website’s code runs in your browser,</strong> so it can be checked directly: the files you download are the ones built from the public commit.</li>
          <li>
            <strong>Code on our servers can’t be inspected from outside:</strong> a server could claim any version. What you can check is that the
            image was built by public CI from that commit and signed. Production runs that image.
          </li>
        </ul>

        <h2>What isn’t in the repo</h2>
        <ul className="list-disc pl-5">
          <li><strong>Secrets and settings:</strong> passwords, API keys and environment settings. The public build settings are listed in the server’s answer above.</li>
          <li><strong>Services we use:</strong> Stripe for card payments, Cloudflare R2 for file storage, Fly.io for Design Studio workers, Railway for hosting, and email delivery.</li>
          <li><strong>Your data:</strong> how we handle it is on the <a href="/privacy/" className={link}>privacy page</a>.</li>
        </ul>

        <h2>Report a security issue</h2>
        <p>
          Email <a href="mailto:support@virvi.io" className={link}>support@virvi.io</a>. Please don’t post it publicly until we’ve had a chance
          to fix it. Our <a href="/.well-known/security.txt" className={link}>security.txt</a> has the details.
        </p>
      </article>
    </div>
  )
}
