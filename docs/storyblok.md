# FlowPay Storyblok integration

This integration manages **public website content only**. It does not control customer authentication, account balances, cards, transfers, payments, verification, or admin permissions.

## Storyblok space setup

1. Open the FlowPay space in Storyblok.
2. Open **Settings → Access Tokens**.
3. Create or copy a **Public** Content Delivery API token for the production website. It is read-only and is intended for published content in a frontend.
4. Copy the numeric Space ID and create a **Preview** Content Delivery API token for the Visual Editor.
5. Keep the Preview token private in the FlowPay API service. Never add it to a `VITE_*` variable or the web app.
6. Set the correct region: `eu`, `us`, `ap` (Australia), `ca`, or `cn`.

Storyblok's region-specific Content Delivery API endpoints are documented at https://www.storyblok.com/docs/api/content-delivery/v2. Its Visual Editor security guide requires the preview URL signature to be validated server-side; this repository implements that validation in `/storyblok/preview`.

## Render environment variables

### FlowPay web service

- `VITE_STORYBLOK_DELIVERY_API_TOKEN`: the Storyblok **Public** Content Delivery API token.
- `VITE_STORYBLOK_REGION`: the Space region (`eu`, `us`, `ap`, `ca`, or `cn`).
- `VITE_API_BASE_URL`: the existing FlowPay API base URL.

Only the public read-only token is exposed in the frontend bundle. Do not set the Preview token on the web service.

### FlowPay API service

- `STORYBLOK_SPACE_ID`: numeric Storyblok Space ID.
- `STORYBLOK_PREVIEW_API_TOKEN`: the Space's Preview Content Delivery API token (private server environment variable).
- `STORYBLOK_REGION`: the same region code as the Space.

The API validates `_storyblok_tk[space_id]`, `_storyblok_tk[timestamp]`, and `_storyblok_tk[token]` before fetching draft content. Signed links older than one hour or from a different Space are rejected. Preview responses are `no-store`.

## Story content model

Create these stories in Storyblok:

| Story | Slug | Real path |
|---|---|---|
| Home | `home` | `/` |
| About | `about` | `/about` |
| Services | `services` | `/services` |

Set the root content type to `page` (or `home`) with a `body` Blocks field.

The FlowPay renderer supports these block technical names:

- `hero`: `eyebrow`, `headline`, `text`, `image`, `image_alt`, `primary_label`, `primary_link`, `secondary_label`, `secondary_link`.
- `feature_grid`, `services_grid`, `grid`: `title`, `eyebrow`, `text`, and a nested Blocks field named `items` or `body`.
- `feature`, `feature_item`, `service_card`: `title`, `text`, optional `icon`, `link_label`, and `link`.
- `text_section`, `rich_text`: `title`, and a Richtext field named `content` or `richtext`.
- `cta`: `title`, `text`, `button_label`, and `button_link`.

For the home story, set its real path to `/` as required by Storyblok's React Visual Editor URL configuration.

## Preview setup

1. Configure the Visual Editor preview URL to the HTTPS FlowPay web URL.
2. Configure the API service with the Space ID, Preview token, and region.
3. Configure the web service with the Public token, API base URL, and region.
4. In Storyblok's Visual Editor, open Home, About, or Services. Storyblok's signed preview query is validated by the API before draft content is returned.
5. Publish content to make it available to the public token in production.

The Visual Editor requires HTTPS. Storyblok documents this requirement and the preview-link signature here: https://www.storyblok.com/docs/concepts/visual-editor.

## Fallback and safety behaviour

- If the public token is absent, invalid, or content is not yet published, FlowPay continues to render its existing landing page.
- The public Storyblok token can read published content only.
- The Preview token remains server-side and can only be used through the signed-preview endpoint.
- Unknown or unsupported content blocks are skipped rather than interpreted as HTML.
- All FlowPay app routes and payment operations remain separate from CMS-managed pages.
