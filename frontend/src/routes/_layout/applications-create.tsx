import { createFileRoute, redirect } from "@tanstack/react-router"

import { UsersService } from "@/client"
import { ApplicationRequestPage } from "@/components/Applications/ApplicationRequestPage"

export const Route = createFileRoute("/_layout/applications-create")({
  component: ApplicationsCreateRoute,
  beforeLoad: async () => {
    const user = await UsersService.readUserMe()
    if (user.role !== "student") {
      throw redirect({
        to: "/applications",
      })
    }
  },
  head: () => ({
    meta: [
      {
        title: "Request Resource - Campus Cloud",
      },
    ],
  }),
})

function ApplicationsCreateRoute() {
  return <ApplicationRequestPage />
}
