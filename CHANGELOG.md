# Changelog

All notable changes to this project will be documented in this file.

## [0.5.1] - 2025-01-XX

### Added
- **Export Server API Enhancements**: Added new REST API endpoints for container management
  - `POST /internal/containers/create`: Create containers programmatically via API
  - `POST /internal/containers/set-proxy`: Dedicated endpoint for setting container proxy configuration
  - `POST /internal/containers/update`: Update container properties (name, proxy, etc.)
  - `POST /internal/export-restored/close`: Close container windows programmatically (idempotent)
  - `setFileInput` command in `/internal/exec`: Support for file input operations in remote exec API
- **Device ID Management**: Added `getOrCreateDeviceId()` for consistent device identification
- **Enhanced Error Handling**: Improved error responses and logging in export server

### Changed
- **Export Server**: Enhanced error handling and response formatting
- **Container Manager**: Improved container lifecycle management
- **Database**: Enhanced container management operations
- **Documentation**: Major updates to PROJECT_OVERVIEW.md and README.md with comprehensive API documentation

### Technical
- Improved logging with context information in export server
- Better error handling for API operations
- Enhanced type safety with proper TypeScript types

## [0.5.0] - 2025-12-02

### Added
- **Container Status Feature**: Added status management for containers
  - Three status options: 未使用 (Unused), 稼働中 (Running), 停止 (Stopped)
  - Status display in container list with color indicators
    - 稼働中 (Running): Green (#28a745)
    - 停止 (Stopped): Red (#dc3545)
    - 未使用 (Unused): Gray (#6c757d)
  - Status can be edited in the settings dialog

- **Token-less Operation**: Application now works without authentication token
  - No restrictions on container creation when token is not set
  - Graceful fallback when authentication API is unavailable
  - "Info" notification (not warning) when no token is configured

- **Settings Screen Improvements**:
  - Advanced settings renamed to "Troubleshooting"
  - API base URL configuration is now a collapsible troubleshooting section
  - Cleaner UI presentation

### Changed
- **Database Schema**: Added `status` column to containers table
  - Automatic migration for existing databases
  - Default status: '未使用' (Unused)

- **UI/UX**:
  - Container list now displays status instead of memo text
  - Status appears below container name and above ID
  - Memo field retained in settings dialog for notes

- **Authentication Flow**:
  - Token validation now optional - app continues to work if validation fails
  - Better error handling and logging for auth API failures

### Fixed
- Improved error handling for quota consumption
- Better session expiry detection and handling
- Fixed token information display refresh

### Technical
- Enhanced database migration system
- Improved error logging with context information
- Better fallback mechanisms for API failures

## [0.4.4] - Previous Release

(Previous changelog entries...)

