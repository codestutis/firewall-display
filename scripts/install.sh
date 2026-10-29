#!/bin/bash

# https://raw.githubusercontent.com/codestutis/firewall-display/main/scripts/install.sh
# This script downloads and installs the OPNsense Firewall Display Service from the latest git commit. It also sets up a systemd service to manage the application.

GITHUB_REPOSITORY="codestutis/firewall-display"
REPOSITORY_URL="https://github.com/${GITHUB_REPOSITORY}.git"

set -e
set -o pipefail

# Function to confirm a value, returns the value confirmed (aka, yes/no, if no ask for new value)
util_confirm_value() {
    local prompt_message="$1"
    local current_value="$2"
    local user_input

    while true; do
        read -rp "${prompt_message} [${current_value}]: " user_input
        user_input="${user_input:-$current_value}"

        read -rp "You entered '${user_input}'. Is this correct? (y/n): " confirmation
        case $confirmation in
            [Yy]* ) echo "$user_input"; return ;;
            [Nn]* ) echo "Let's try again." ;;
            * ) echo "Please answer Y/y or N/n." ;;
        esac
    done
}

# Function to ensure prerequisites are met
ensure_prereqs() {
    local prereqs=(jq wget nano tar go bun)

    for cmd in "${prereqs[@]}"; do
        if ! command -v "$cmd" &> /dev/null; then
            echo "Error: $cmd is not installed. Please install it and try again."
            exit 1
        fi
    done
}

# Function to display usage information
usage() {
    echo "Usage: $0 [options]"
    echo "Options:"
    echo "  -h, --help          Show this help message and exit"
    echo "  -i, --install       Install from latest git commit"
    echo "  -p, --purge         Uninstall from the system"
    exit 0
}

# Function to install a specified release
install_service() {
    local install_dir=$(util_confirm_value "Enter installation directory" "/opt/opnsense-firewall-display")
    local service_user="fwdisplay"
    local current_user="$(whoami)"
    local existing_remote=""

    # Create installation directory if it doesn't exist
    sudo mkdir -p "$install_dir"
    sudo chown -R "$current_user":"$current_user" "$install_dir"

    # Clone a fresh checkout or update an existing deployment in place.
    if [ -d "${install_dir}/.git" ]; then
        existing_remote="$(git -C "$install_dir" config --get remote.origin.url || true)"
        if [[ "$existing_remote" != *"${GITHUB_REPOSITORY}"* ]]; then
            echo "Error: ${install_dir} already contains a different git repository."
            exit 1
        fi

        echo "Existing deployment detected, updating repository..."
        git -C "$install_dir" fetch --depth 1 origin main
        git -C "$install_dir" checkout -B main FETCH_HEAD
    else
        if [ -n "$(find "$install_dir" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]; then
            echo "Error: ${install_dir} already exists and is not an empty directory."
            echo "If this is an existing deployment, it must contain the ${GITHUB_REPOSITORY} git checkout."
            exit 1
        fi

        git clone --depth 1 "${REPOSITORY_URL}" "$install_dir"
    fi

    cd "$install_dir"

    go build -o fwdisplay .
    chmod +x fwdisplay
    cd client
    bun install
    bun run build

    # Create a dedicated user for the service (if not exists)
    if ! id -u "$service_user" &> /dev/null; then
        sudo useradd -r -s /bin/false "$service_user"
    fi

    # Set ownership of installation directory
    sudo chown -R "$service_user":"$service_user" "$install_dir"

    # The user should be allowed to bind on low ports if needed
    sudo setcap 'cap_net_bind_service=+ep' "${install_dir}/fwdisplay"

    # Create a systemd service file
    local service_file="/etc/systemd/system/fwdisplay.service"
    sudo bash -c "cat > $service_file" <<EOL
[Unit]
Description=OPNsense Firewall Display Service
After=network.target

[Service]
Type=simple
User=${service_user}
ExecStart=${install_dir}/fwdisplay
WorkingDirectory=${install_dir}
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOL

    # Reload systemd, enable and start the service
    sudo systemctl daemon-reload

    # The first run of the binary makes the config.toml file if it doesn't exist. So we check if config.toml exists, if not we run the binary once to create it.
    if [ ! -f "${install_dir}/config.toml" ]; then
        echo "Creating initial config.toml file..."
        # This will error out, it shouldn't crash the script though. We just want to create the config.toml file. Make sure not to let it output to the user.
        sudo su - "$service_user" -s /bin/bash -c "cd ${install_dir} && ./fwdisplay" &> /dev/null || true
    fi

    # Ask to configure the config.toml file (y/n)
    read -rp "Would you like to configure the config.toml file now? (y/n) (If this is an initial setup, this is highly recommended!): " configure_env
    if [[ "$configure_env" =~ ^[Yy]$ ]]; then
        sudo nano "${install_dir}/config.toml"
    fi

    sudo systemctl enable fwdisplay.service
    sudo systemctl restart fwdisplay.service
    echo "Sucessfully installed the OPNsense Firewall Display Service! The service is now running and will start on boot. You can manage the service using 'sudo systemctl [start|stop|restart] fwdisplay.service'."
    exit 0
}

# Function to uninstall service
uninstall_service() {
    local install_dir=$(util_confirm_value "Enter installation directory to remove" "/opt/opnsense-firewall-display")
    local service_user="fwdisplay"

    # Stop and disable the service
    sudo systemctl stop fwdisplay.service || true
    sudo systemctl disable fwdisplay.service || true

    # Remove systemd service file
    sudo rm -f /etc/systemd/system/fwdisplay.service
    sudo systemctl daemon-reload

    # Remove installation directory
    sudo rm -rf "$install_dir"

    # Remove dedicated user
    sudo userdel "$service_user" || true

    # Remove capabilities
    sudo setcap -r "${install_dir}/fwdisplay" || true
    
    echo "Service uninstalled successfully from ${install_dir}."
    
    exit 0
}

# Main script execution starts here
ensure_prereqs

# Parse command-line arguments
while [[ "$#" -gt 0 ]]; do
    case $1 in
        -h|--help) usage ;;
        -i|--install) install_service ;;
        -p|--purge) uninstall_service ;;
        *) echo "Unknown parameter passed: $1"; usage ;;
    esac
    shift
done

usage
