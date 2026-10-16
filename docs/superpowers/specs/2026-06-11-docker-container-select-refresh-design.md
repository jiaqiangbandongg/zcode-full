# Docker Container Select Refresh Design

## Background

Docker remote connection currently loads running containers when the remote connection dialog first enters the Docker settings step. The list is then held in UI state for the lifetime of that dialog instance. If containers are started or stopped after that initial load, opening the "Choose a running container" dropdown can show stale data.

## Goal

Refresh the Docker running-container list when the Docker container dropdown opens, while keeping the existing initial lazy load when the user enters the Docker settings step.

## Behavior

- The Docker settings step still performs its first lazy Docker availability/container load when opened.
- Opening the running-container dropdown triggers one additional refresh against the platform Docker APIs.
- Closing the dropdown does not refresh.
- If a refresh is already in flight, another dropdown-open event does not start a second Docker command.
- Refresh success replaces the dropdown list with the latest running containers.
- Refresh success also reconciles the selected container with the latest running-container list. If the previously selected container is no longer running, the dropdown selection is cleared so the trigger shows the empty-state hint instead of a stale container name.
- Refresh failure keeps the previous dropdown list and surfaces the existing remote options load error banner.
- If Docker is reported unavailable, the container list is cleared because there is no current daemon-backed list to show.
- The running-container chooser uses the same `Popover + Command` interaction pattern as other searchable dropdowns in the UI instead of Radix `Select`.
- While a dropdown-open refresh is running, the chooser shows a loading indicator in the trigger and a loading row in the menu.
- When no running containers are available or Docker availability detection reports unavailable, the trigger and menu show a short grey hint that no running containers were detected.
- A separate manual "Container" input remains available below the chooser for cases where the running-container list is incomplete or Docker detection is unavailable.
- The manual input and dropdown selection are independent state values. Choosing an item from the dropdown must not populate the manual input, and typing in the manual input must not change the dropdown selection.
- When connecting, a non-empty manual input value takes precedence over the dropdown selection. If the manual input is empty, the selected dropdown container is used.
- When the manual input is empty, the UI shows a grey localized hint explaining that users can manually enter a container name or ID if the running-container list is incomplete.

## Boundaries

- UI components do not call Docker or platform APIs directly. `useRemoteConnectionForm` owns platform access and state updates.
- `RemoteConnectionFields` only reports that the Docker container select opened.
- The dropdown empty-state hint and manual-input helper text are localized in both `zh-CN` and `en-US`.

## Verification

- Add a unit test proving the Docker select open event invokes the supplied refresh callback only when the select opens.
- Add a unit test proving Docker option loading calls Docker APIs and reports errors without throwing.
- Add a unit test proving stale selected Docker containers are cleared after a successful refresh removes them from the running-container list.
- Add a unit test proving the Docker chooser is rendered through `Popover + Command`, shows loading, and renders the empty-state hint when there are no containers.
- Add a unit test proving the manual Docker container input renders independently from the dropdown selection and shows its helper text.
- Add a unit test proving Docker connection target creation prefers manual input over dropdown selection and falls back to the dropdown selection when manual input is empty.
- Run targeted unit tests, `pnpm typecheck`, and `pnpm lint`.
