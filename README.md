# Drone Ranger

Drone Ranger is an early-stage RF coverage planning tool for drone links. It maps line-of-sight and link-margin coverage around an operator position using Mapbox maps, terrain, buildings, and optional vegetation canopy data.

The app is intended to be used as a ready-to-go desktop app. Portable builds are published from this repository, and the same codebase can also run in a browser during development.

## Download

For most users, download the latest portable build from the repository's release artifacts and run it directly. No Node.js, pnpm, or install step is required.

On first launch, Drone Ranger asks for a Mapbox access token and stores it locally on your machine. You can use a normal public Mapbox token.

## Features

- Interactive Mapbox map with draggable operator position.
- RF profiles for control, telemetry, and video links.
- Combined or per-link coverage views.
- Terrain-aware line-of-sight analysis.
- Optional building and vegetation occlusion.
- CPU and GPU coverage rendering paths.
- Inspector readout for clicked coverage points.
- Portable Electron build support.

## Status

This project is pre-release software. Treat coverage output as a planning aid, not as an aviation, legal, or safety guarantee. Real-world link quality depends on hardware, antennas, interference, weather, Fresnel clearance, local rules, and site conditions.

## Propagation Model

The coverage map shows the minimum drone altitude at which a straight operator-to-drone ray clears every terrain, building, and canopy sample along the path, combined with a free-space link budget.

Modelled:

- Free-space path loss with per-link gains, losses, receiver sensitivity, and a fixed required margin.
- Earth curvature with an effective earth radius factor (k). The default k = 4/3 represents standard atmospheric refraction; k = 1 is the geometric earth, and "Off" gives a flat vertical profile.
- Terrain, building, and vegetation obstruction as hard blockers.

Reported in the inspector but not enforced:

- First Fresnel zone radius at the limiting obstacle and the altitude that would keep 0.6·F1 clearance along the whole path, using the lowest active link frequency.

Not modelled yet: diffraction loss over obstacles, atmospheric gas and rain attenuation, foliage loss in dB, ground reflection and multipath, antenna patterns, and interference.

## Requirements

- A portable desktop build.
- A Mapbox access token.

The app uses Mapbox for maps, terrain, and building data. Vegetation canopy data is loaded from Source Cooperative's Meta CHM dataset when vegetation occlusion is enabled.

## Development Setup

Developer commands require Node.js and pnpm. End users of the portable build do not need these tools.

Install dependencies:

```sh
pnpm install
```

Create a local environment file:

```sh
cp .env.example .env
```

Then add your normal Mapbox access token to `.env`. The `VITE_` prefix is only there so Vite exposes the value to the browser app during development:

```sh
VITE_MAPBOX_TOKEN=your_mapbox_token_here
```

Do not commit `.env`.

## Development

Start the Vite development server:

```sh
pnpm dev
```

Open the local URL printed by Vite.

To run the Electron app in development:

```sh
pnpm electron:dev
```

## Testing

Run the unit tests:

```sh
pnpm test
```

Additional browser-based regression and validation scripts are available:

```sh
pnpm test:operator-move
pnpm test:grid-size-freeze
pnpm test:gpu
pnpm bench:click-to-overlay
```

## Build

Build and compile the app:

```sh
pnpm app:build
```

Build a portable desktop app using the package script for the target you need. Available package scripts are listed in `package.json`.

## Mapbox Access Token

During browser development, the app reads the Mapbox access token from `VITE_MAPBOX_TOKEN` in `.env`. This is a standard Mapbox token; only the environment variable name is Vite-prefixed.

In the packaged Electron app, Drone Ranger prompts for a Mapbox access token and stores it locally on the user's machine.

## Data Sources

- Map display, terrain, and building data: Mapbox.
- Vegetation canopy height: Meta CHM tiles from Source Cooperative.

Review each provider's terms before distributing builds or using the app operationally.

## Repository Notes

Generated output, local environment files, release artifacts, dependency folders, and local helper scripts are ignored by Git.

## License

No license has been selected yet. Until a license is added, all rights are reserved by the copyright holder.
