// Photo + audio for each contestant, keyed by the exact label in data.json.
// Adjust the paths if your files are named differently.
const contestantMedia = {
    "Prisca (Lagos)": { img: "/images/14.jpeg", audio: "/Audio/Prisca.ogg" },
    "Victor (Lagos)": { img: "/images/13.jpeg", audio: "/Audio/Victor.ogg" },
    "Mercy (Osun)":   { img: "/images/15.jpeg", audio: "/Audio/Mercy.ogg" },
}

// The browser remembers who has voted under this name. It lasts across tabs and restarts.
// To let EVERYONE vote again (for example after a reset), change "v1" to "v2".
const STORAGE_KEY = "voted_v1"

class Poll {
    constructor(root) {
        this.root = root
        this.selected = localStorage.getItem(STORAGE_KEY)
        // Relative URL: works locally and once deployed, since the same server serves the page
        this.endpoint = "/poll"

        this._refresh()
    }

    async _refresh() {
        let data
        try {
            const response = await fetch(this.endpoint)
            if (!response.ok) throw new Error("Server returned " + response.status)
            data = await response.json()
        } catch (err) {
            console.error("Could not load poll:", err)
            this.root.innerHTML = '<p style="color:aliceblue">Could not load contestants. Please try again.</p>'
            return
        }

        // Clear everything from the previous render
        this.root.innerHTML = ""

        for (const option of data) {
            const media = contestantMedia[option.label] || {}
            const isSelected = this.selected === option.label

            const template = document.createElement("template")
            template.innerHTML = `
                <div class="option ${isSelected ? "selected" : ""}">
                    <div class="contestant-card">
                        ${media.img ? `<img src="${media.img}" alt="${option.label}">` : ""}
                        <div class="contestant-info">
                            <h3>${option.label}</h3>
                            ${media.audio ? `<audio controls preload="none" src="${media.audio}"></audio>` : ""}
                            <div>
                                <button class="vote" ${this.selected ? "disabled" : ""}>${isSelected ? "VOTED" : "VOTE"}</button>
                                <span style="color: aliceblue;">${option.percentage}%</span>
                            </div>
                        </div>
                    </div>
                </div>
            `
            const fragment = template.content

            if (!this.selected) {
                fragment.querySelector(".vote").addEventListener("click", () => this._vote(option.label))
            }

            this.root.appendChild(fragment)
        }
    }

    async _vote(label) {
        try {
            const response = await fetch(this.endpoint, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ add: label }),
            })
            if (response.status === 409) {
                // The server already has a vote from this browser
                this.selected = "already"
                localStorage.setItem(STORAGE_KEY, "already")
                alert("You have already voted. Thank you!")
                this._refresh()
                return
            }
            if (response.status === 429) {
                alert("Too many votes have already come from this network. Please try from a different connection.")
                return
            }
            if (!response.ok) throw new Error("Server returned " + response.status)

            // Only lock the user out after the vote actually succeeded
            this.selected = label
            localStorage.setItem(STORAGE_KEY, label)
            this._refresh()
        } catch (err) {
            console.error("Vote failed:", err)
            alert("Your vote could not be saved. Please try again.")
        }
    }
}

new Poll(document.querySelector(".contestant-list"))
