# Changelog

All notable changes to this project will be documented in this file.

## [0.5.4] - 2025-01-XX

### Added
- **Export Container List Feature**: Added support for export target container list file
  - Export target containers can be specified via `export-container-list.txt` file
  - Supports container ID or name specification (one per line)
  - Supports comments (lines starting with `#`) and empty lines
  - File location: `%APPDATA%\container-browser\export-container-list.txt`
- **Export Progress Display**: Added real-time progress reporting for export operations
  - Progress events can be monitored via `window.migrationAPI.onExportProgress()`
  - Shows current/total counts and percentage for each step
  - Displays detailed progress for container processing, file operations, and archiving
- **Export Optimization**: Significantly reduced export size and time by excluding cache files
  - Excludes Cache, Code Cache, GPUCache, Service Worker, Media Cache, ShaderCache, and other temporary files
  - Maintains essential data for login state (Cookies, Local Storage, IndexedDB, etc.)
  - Export size reduced from 50GB+ to manageable sizes, processing time reduced from hours to minutes

### Changed
- **Export Processing**: Banned group containers are now excluded from export operations
  - Containers in Banned group are automatically excluded even if listed in export-container-list.txt
  - Improved export target filtering logic

### Technical
- Enhanced export server with container list file reading
- Improved progress reporting infrastructure
- Optimized file filtering for export operations
- Better error handling and logging for export operations

## [0.5.2] - 2025-01-XX

### Added
- **Media Download Feature**: Added `save_media` command to `/internal/exec` endpoint
  - Extracts image and video URLs from web pages using CSS selectors
  - Supports `<img>`, `<video>`, and `<source>` elements
  - Downloads media files to specified local directory with automatic file naming
  - Returns detailed download results including file paths, sizes, and MIME types
  - Supports partial failure handling (continues downloading even if some files fail)
  - Maximum 100 files per request, 500MB per file limit
  - Configurable timeout (default 60 seconds)
  - Automatic file extension detection from URLs or content type

### Changed
- **Documentation**: Updated PROJECT_OVERVIEW.md with `save_media` command documentation
  - Added request/response examples
  - Added feature descriptions and usage notes

### Technical
- Enhanced export server with media download utilities
- Added file size and MIME type detection
- Improved error handling for download operations
- Added URL validation and deduplication

## [0.5.1] - 2025-12-12

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

