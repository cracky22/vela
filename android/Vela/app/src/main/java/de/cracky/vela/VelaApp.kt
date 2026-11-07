package de.cracky.vela

import android.app.Application
import de.cracky.vela.data.Repo
import de.cracky.vela.service.Notifier

class VelaApp : Application() {
    lateinit var repo: Repo
        private set

    override fun onCreate() {
        super.onCreate()
        Notifier.createChannels(this)
        repo = Repo(this)
    }
}
