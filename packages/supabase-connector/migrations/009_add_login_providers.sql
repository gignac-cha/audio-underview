-- Migration: Add login providers threads, tiktok, line, bluesky, twitch to provider_type
ALTER TYPE provider_type ADD VALUE IF NOT EXISTS 'threads';
ALTER TYPE provider_type ADD VALUE IF NOT EXISTS 'tiktok';
ALTER TYPE provider_type ADD VALUE IF NOT EXISTS 'line';
ALTER TYPE provider_type ADD VALUE IF NOT EXISTS 'bluesky';
ALTER TYPE provider_type ADD VALUE IF NOT EXISTS 'twitch';
