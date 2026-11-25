// Photo + audio for each contestant, keyed by the exact label in data.json.
// Adjust the paths if your files are named differently.
const contestantMedia = {
    "Prisca (Lagos)": { img: "/images/14.jpeg", audio: "/Audios/1.ogg" },
    "Victor (Lagos)": { img: "/images/13.jpeg", audio: "/Audios/1.ogg" },
    "Mercy (Osun)":   { img: "/images/15.jpeg", audio: "/Audios/1.ogg" },
}

class Poll {
    constructor(root) {
        this.root = root
        this.selected = sessionStorage.getItem("selected")
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
            if (!response.ok) throw new Error("Server returned " + response.status)

            // Only lock the user out after the vote actually succeeded
            this.selected = label
            sessionStorage.setItem("selected", label)
            this._refresh()
        } catch (err) {
            console.error("Vote failed:", err)
            alert("Your vote could not be saved. Please try again.")
        }
    }
}

new Poll(document.querySelector(".contestant-list"))
