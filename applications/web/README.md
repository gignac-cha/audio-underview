# @audio-underview/web

React SPA with Google SSO authentication.

## Prerequisites

- Node.js >= 25.0.0
- pnpm >= 10.26.0

## Setup

```bash
pnpm install
```

## Development

```bash
pnpm dev
```

## Environment Variables

Copy `.env.example` to `.env` and fill in the values:

```bash
cp .env.example .env
```

| Variable | Description | Required |
|----------|-------------|----------|
| `VITE_GOOGLE_CLIENT_ID` | Google OAuth 2.0 Client ID | Yes |

### Getting Google OAuth Client ID

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select an existing one
3. Navigate to **APIs & Services** > **Credentials**
4. Click **Create Credentials** > **OAuth client ID**
5. Select **Web application** as the application type
6. Add authorized JavaScript origins:
   - `http://localhost:5173` (development)
   - `https://your-domain.pages.dev` (production)
7. Copy the **Client ID** and set it as `VITE_GOOGLE_CLIENT_ID`

## GitHub Actions Secrets

For Cloudflare Pages deployment, configure these secrets in your repository:

| Secret | Description | Required |
|--------|-------------|----------|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API Token with Pages edit permission | Yes |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Account ID | Yes |
| `VITE_GOOGLE_CLIENT_ID` | Google OAuth Client ID for production build | Yes |

### Getting Cloudflare Credentials

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. **Account ID**: Found in the right sidebar of the dashboard
3. **API Token**:
   - Navigate to **My Profile** > **API Tokens**
   - Click **Create Token**
   - Use the **Edit Cloudflare Workers** template
   - Scope to your account and enable Cloudflare Pages permissions

## Deployment

### Manual Deployment (workflow_dispatch)

1. Go to **Actions** tab in GitHub
2. Select **Deploy Web to Cloudflare Pages**
3. Click **Run workflow**

The application will be deployed to Cloudflare Pages at `https://audio-underview.pages.dev`

## Tech Stack

- **Framework**: React 19, React Router 7
- **State Management**: Zustand, Jotai, Recoil
- **Data Fetching**: TanStack React Query
- **Styling**: Sass, Emotion
- **UI Components**: Radix UI
- **Icons**: FontAwesome
- **Validation**: Zod
- **Build Tool**: Vite
- **Testing**: Vitest, Playwright
- **Documentation**: Storybook
- **Deployment**: Cloudflare Pages
